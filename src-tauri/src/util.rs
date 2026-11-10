use std::fmt;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

// Product identity is deliberately shared with the upstream Electron launcher:
// same app name, same `%APPDATA%\Pi Launcher` data directory, and the same
// `launcher-config.json` / `launcher.log` / `pi-web-<port>.json` files. Switching
// versions needs no reconfiguration. Do not run both launchers at once though —
// their single-instance locks are independent.
pub const APP_NAME: &str = "Pi Launcher";
pub const HOST: &str = "127.0.0.1";

#[derive(Debug)]
pub struct Error(pub String);

pub type Result<T> = std::result::Result<T, Error>;

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(value: std::io::Error) -> Self {
        Error(value.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(value: serde_json::Error) -> Self {
        Error(value.to_string())
    }
}

pub fn err(message: impl Into<String>) -> Error {
    Error(message.into())
}

/// Lock helper that ignores poisoning.
///
/// A panic in one thread must not turn every later `lock()` into a second
/// panic: the state behind these mutexes (zoom, phase, server handle) is still
/// structurally valid, and the launcher is better off degraded than dead.
pub fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// UTF-8 (no BOM), append-only. Mirrors the Electron launcher's launcher.log.
/// Every line carries both an absolute UTC timestamp and the milliseconds
/// elapsed since `mark_start`, so a cold start can be reconstructed from the
/// log without extra instrumentation.
pub fn log(state_dir: &Path, message: &str) {
    append(state_dir, message, None);
}

pub fn log_error(state_dir: &Path, message: &str, error: &dyn fmt::Display) {
    append(state_dir, message, Some(error.to_string()));
}

/// Set once at the top of `run()`; all elapsed values are relative to it.
pub fn mark_start() {
    let _ = START.set(Instant::now());
}

pub fn elapsed_ms() -> u128 {
    START
        .get()
        .map(|start| start.elapsed().as_millis())
        .unwrap_or(0)
}

static START: OnceLock<Instant> = OnceLock::new();

fn append(state_dir: &Path, message: &str, detail: Option<String>) {
    let suffix = detail.map(|d| format!(" {d}")).unwrap_or_default();
    let line = format!("[{} +{:>6}ms] {message}{suffix}\n", iso_now(), elapsed_ms());
    eprint!("{line}");

    // One handle for the life of the process: the backend's stdout is mirrored
    // here too, so reopening the file per line is thousands of extra syscalls
    // in a long session.
    let mut guard = LOG.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    let path = state_dir.join("launcher.log");
    let stale = guard.as_ref().map(|open| open.path != path).unwrap_or(true);
    if stale {
        let _ = fs::create_dir_all(state_dir);
        *guard = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()
            .map(|file| {
                let written = file.metadata().map(|meta| meta.len()).unwrap_or(0);
                LogFile {
                    path: path.clone(),
                    file,
                    written,
                }
            });
    }
    // The log is append-only and never trimmed by the app, so rotate it once it
    // grows past a size a text editor can still open comfortably.
    let rotate = guard
        .as_ref()
        .map(|open| open.written > LOG_ROTATE_BYTES)
        .unwrap_or(false);
    if rotate {
        *guard = None;
        let rotated = path.with_extension("log.1");
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(&path, &rotated);
        *guard = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .ok()
            .map(|file| LogFile {
                path: path.clone(),
                file,
                written: 0,
            });
    }
    if let Some(open) = guard.as_mut() {
        if open.file.write_all(line.as_bytes()).is_ok() {
            open.written += line.len() as u64;
        }
    }
}

struct LogFile {
    path: PathBuf,
    file: fs::File,
    written: u64,
}

const LOG_ROTATE_BYTES: u64 = 4 * 1024 * 1024;

static LOG: std::sync::Mutex<Option<LogFile>> = std::sync::Mutex::new(None);

fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    format!(
        "{}.{:03}Z",
        iso_from_unix(now.as_secs() as i64),
        now.subsec_millis()
    )
}

/// Sortable UTC stamp without the fraction, used by both the log and the
/// process-creation-time records.
fn iso_from_unix(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}",
        rem / 3600,
        rem % 3600 / 60,
        rem % 60
    )
}

/// FILETIME (100 ns ticks since 1601-01-01 UTC) -> `2026-11-10T13:02:25.1234567Z`.
/// CIM exposes only microseconds. Keep the seven-digit .NET round-trip shape,
/// but truncate the last (100 ns) digit so Electron can also read our records.
pub fn iso_from_filetime(ticks: u64) -> String {
    const EPOCH_DIFFERENCE: u64 = 116_444_736_000_000_000; // 1601 -> 1970
    let since_epoch = ticks.saturating_sub(EPOCH_DIFFERENCE);
    format!(
        "{}.{:07}Z",
        iso_from_unix((since_epoch / 10_000_000) as i64),
        (since_epoch % 10_000_000) / 10 * 10
    )
}

/// Compare UTC process stamps at CIM's microsecond precision. Older native
/// records contain one extra significant digit; discard *only* that digit.
/// Reject other shapes rather than allowing a malformed identity to match.
pub fn creation_times_match(left: Option<&str>, right: Option<&str>) -> bool {
    fn normalized(value: &str) -> Option<&str> {
        let b = value.as_bytes();
        if !matches!(b.len(), 27 | 28)
            || b.last() != Some(&b'Z')
            || !b.iter().enumerate().all(|(i, c)| match i {
                4 | 7 => *c == b'-',
                10 => *c == b'T',
                13 | 16 => *c == b':',
                19 => *c == b'.',
                i if i == b.len() - 1 => *c == b'Z',
                _ => c.is_ascii_digit(),
            })
        {
            return None;
        }
        let number = |a, z| value[a..z].parse::<u32>().ok();
        let year = number(0, 4)?;
        let month = number(5, 7)?;
        let day = number(8, 10)?;
        let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
        let days = match month {
            2 => {
                if leap {
                    29
                } else {
                    28
                }
            }
            4 | 6 | 9 | 11 => 30,
            1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
            _ => return None,
        };
        if year < 1601
            || day == 0
            || day > days
            || number(11, 13)? > 23
            || number(14, 16)? > 59
            || number(17, 19)? > 59
        {
            return None;
        }
        Some(&value[..26])
    }
    match (left.and_then(normalized), right.and_then(normalized)) {
        (Some(left), Some(right)) => left == right,
        _ => false,
    }
}

// Howard Hinnant's civil_from_days, UTC only.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = mp + if mp < 10 { 3 } else { -9 };
    (y + if m <= 2 { 1 } else { 0 }, m, d)
}

/// `%APPDATA%\Pi Launcher` (identical to the upstream launcher), or an
/// explicitly configured `PI_LAUNCHER_DATA_DIR` resolved like Node's path.resolve.
pub fn resolve_data_dir() -> Result<PathBuf> {
    if let Some(custom) = std::env::var_os("PI_LAUNCHER_DATA_DIR") {
        let p = PathBuf::from(custom);
        return if p.is_absolute() {
            Ok(p)
        } else {
            Ok(std::env::current_dir()?.join(p))
        };
    }
    let appdata = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .ok_or_else(|| err("找不到 %APPDATA%，且未设置 PI_LAUNCHER_DATA_DIR。"))?;
    Ok(appdata.join(APP_NAME))
}

/// WebView2 profile directory: `%LOCALAPPDATA%\Pi Launcher\webview2`.
///
/// Not under `state_dir` on purpose. A Chromium profile grows to hundreds of MB
/// (cache, code cache, GPU cache, LevelDB) and `%APPDATA%` is the *roaming*
/// tree: it gets copied between machines on logon, and a locked/corrupt profile
/// on a network path is a classic Chromium failure. `PI_LAUNCHER_DATA_DIR`
/// keeps everything together, which is what the tests and portable runs want.
pub fn resolve_webview_dir(state_dir: &Path) -> PathBuf {
    if std::env::var_os("PI_LAUNCHER_DATA_DIR").is_some() {
        return state_dir.join("webview2");
    }
    let Some(local) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) else {
        return state_dir.join("webview2");
    };
    let target = local.join(APP_NAME).join("webview2");
    // Move the profile out of Roaming once. Profiles of this size are usually
    // on the same volume, where a rename is free; if it fails (different volume,
    // open handle from an older build) the new location simply starts empty.
    let legacy = state_dir.join("webview2");
    if !target.exists() && legacy.is_dir() {
        let _ = std::fs::create_dir_all(local.join(APP_NAME));
        match std::fs::rename(&legacy, &target) {
            Ok(()) => log(state_dir, "Moved WebView2 profile to %LOCALAPPDATA%"),
            Err(error) => log(
                state_dir,
                &format!("Cannot move the old WebView2 profile out of Roaming: {error}"),
            ),
        }
    }
    target
}

/// Word-boundary path match, equivalent to the launcher's commandHasPath regex.
pub fn command_has_path(command: &str, file: &str) -> bool {
    if file.is_empty() || command.is_empty() {
        return false;
    }
    let haystack = command.to_ascii_lowercase();
    let needle = file.to_ascii_lowercase();
    for (start, _) in haystack.match_indices(&needle) {
        let end = start + needle.len();
        let before = haystack[..start]
            .chars()
            .next_back()
            .map(|c| c.is_whitespace() || c == '"')
            .unwrap_or(true);
        let after = haystack[end..]
            .chars()
            .next()
            .map(|c| c.is_whitespace() || c == '"')
            .unwrap_or(true);
        if before && after {
            return true;
        }
    }
    false
}

/// Matches `--port <n>` or `--port=<n>` (optionally quoted) with a token
/// boundary, so `--port 301410` is not mistaken for `--port 30141`.
pub fn command_has_port(command: &str, port: u16) -> bool {
    let lower = command.to_ascii_lowercase();
    let expected = port.to_string();
    for (start, _) in lower.match_indices("--port") {
        let mut rest = &command[start + "--port".len()..];
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '"' || c == '=');
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if digits.is_empty() || digits != expected {
            continue;
        }
        let tail = &rest[digits.len()..];
        if tail
            .chars()
            .next()
            .map(|c| c.is_whitespace() || c == '"' || c == '\0')
            .unwrap_or(true)
        {
            return true;
        }
    }
    false
}

pub fn is_absolute_path(value: &str) -> bool {
    Path::new(value).is_absolute()
}

pub fn sleep(ms: u64) {
    std::thread::sleep(std::time::Duration::from_millis(ms));
}

#[cfg(test)]
mod tests {
    use super::*;

    const ENTRY: &str = r"C:\pi\backend\bin\pi-web.js";

    #[test]
    fn path_match_needs_token_boundaries() {
        // Standard spawn: quoted executable, quoted script, then arguments.
        assert!(command_has_path(
            r#""C:\Program Files\nodejs\node.exe" "C:\pi\backend\bin\pi-web.js" --port 30141"#,
            ENTRY
        ));
        assert!(command_has_path(
            r#"C:\pi\backend\bin\pi-web.js --hostname 127.0.0.1"#,
            ENTRY
        ));
        // Windows paths are case-insensitive.
        assert!(command_has_path(
            r#"C:\PI\BACKEND\BIN\PI-WEB.JS --port 30141"#,
            ENTRY
        ));
    }

    #[test]
    fn path_match_rejects_lookalikes() {
        // Longer file name: the byte after the match is `.`, not a separator.
        assert!(!command_has_path(
            r"C:\pi\backend\bin\pi-web.js.bak --port 30141",
            ENTRY
        ));
        // Same suffix, different file.
        assert!(!command_has_path(
            r"C:\other\C:\pi\backend\bin\pi-web.js",
            ENTRY
        ));
        assert!(!command_has_path("", ENTRY));
    }

    #[test]
    fn port_match_accepts_both_argument_styles() {
        assert!(command_has_port("node pi-web.js --port 30141", 30141));
        assert!(command_has_port("node pi-web.js --port=30141", 30141));
        assert!(command_has_port(r#"node pi-web.js --port "30141""#, 30141));
        assert!(command_has_port("node pi-web.js --port 30141\r\n", 30141));
        assert!(command_has_port("node pi-web.js --PORT 30141", 30141));
    }

    #[test]
    fn port_match_rejects_prefixes_and_other_ports() {
        // The classic mistake: 301410 contains "30141" but is a different port.
        assert!(!command_has_port("node pi-web.js --port 301410", 30141));
        assert!(!command_has_port("node pi-web.js --port 3014", 30141));
        assert!(!command_has_port("node pi-web.js --port", 30141));
        assert!(!command_has_port("node pi-web.js", 30141));
    }

    #[test]
    fn filetime_epoch_is_1970() {
        // 1601-01-01 -> 1970-01-01 expressed in 100 ns ticks.
        assert_eq!(
            iso_from_filetime(116_444_736_000_000_000),
            "1970-01-01T00:00:00.0000000Z"
        );
        assert_eq!(
            iso_from_filetime(116_444_736_000_000_000 + 10_000_000),
            "1970-01-01T00:00:01.0000000Z"
        );
    }

    #[test]
    fn creation_times_bridge_cim_and_native_without_rounding() {
        let cim = "2026-11-10T13:02:25.1234560Z";
        let native = "2026-11-10T13:02:25.1234567Z";
        assert!(creation_times_match(Some(cim), Some(native)));
        assert!(creation_times_match(Some(native), Some(cim)));
        assert!(creation_times_match(
            Some(cim),
            Some("2026-11-10T13:02:25.123456Z")
        ));
        assert!(!creation_times_match(
            Some(cim),
            Some("2026-11-10T13:02:25.1234570Z")
        ));
        assert!(!creation_times_match(
            Some(cim),
            Some("2026-11-10T13:02:26.1234560Z")
        ));
        assert_eq!(
            iso_from_filetime(116_444_736_000_000_000 + 1_234_567),
            "1970-01-01T00:00:00.1234560Z"
        );
    }

    #[test]
    fn creation_times_reject_invalid_shapes_even_when_identical() {
        for value in [
            "",
            "garbage",
            "2026-11-10T13:02:25.12345Z",
            "2026-11-10T13:02:25.12345678Z",
            "2026-11-10T13:02:25.1234560+00:00",
            "2026-11-10T13:02:25.abcdef0Z",
            "2026-02-29T13:02:25.1234560Z",
            "2026-13-10T13:02:25.1234560Z",
            "2026-11-10T24:02:25.1234560Z",
            "2026-11-10T13:60:25.1234560Z",
            "2026-11-10T13:02:60.1234560Z",
            "2026-11-10T13:02:25.123456é",
        ] {
            assert!(!creation_times_match(Some(value), Some(value)), "{value}");
        }
        assert!(!creation_times_match(None, None));
        assert!(!creation_times_match(
            Some("2026-11-10T13:02:25.1234560Z"),
            None
        ));
        assert!(creation_times_match(
            Some("2024-02-29T13:02:25.1234560Z"),
            Some("2024-02-29T13:02:25.1234569Z")
        ));
    }

    #[test]
    fn absolute_paths_only() {
        assert!(is_absolute_path(r"C:\Users\moza"));
        assert!(is_absolute_path(r"\\server\share"));
        assert!(!is_absolute_path("backend"));
        assert!(!is_absolute_path(""));
    }
}
