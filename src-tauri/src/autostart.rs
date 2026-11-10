//! Opt-in, current-user login startup. No installer/startup-time writes, shell,
//! elevated access, or StartupApproved changes. Only the tray may call toggle.

use std::path::Path;

use serde::Serialize;

const VALUE_NAME: &str = "Pi Launcher";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const MAX_REG_SZ_UNITS: usize = 32_768;
// Windows documents a 260-character limit for Run command lines.
const MAX_RUN_COMMAND_UNITS: usize = 260;
const CONFLICT: &str = "同名登录启动项属于其他命令，未作修改。请先在系统设置中核对。";
const CHANGED: &str = "登录启动项已被其他程序更改，未作修改。请重新打开菜单确认。";

type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
pub(crate) struct Status {
    /// None means unreadable/conflicting, never an assumed disabled state.
    pub enabled: Option<bool>,
    pub error: Option<String>,
}

impl Status {
    pub(crate) fn unknown(message: &str) -> Self {
        Self {
            enabled: None,
            error: Some(message.to_owned()),
        }
    }
}

/// Quote one literal executable, with no arguments or shell interpretation.
/// Reject unrepresentable/unsafe paths rather than silently using a lossy path.
fn command_for_exe(path: &Path) -> Result<String> {
    let text = path
        .to_str()
        .ok_or_else(|| "无法无损表示当前程序路径。".to_owned())?;
    if !path.is_absolute()
        || text.ends_with(['\\', '/'])
        || text.chars().any(|ch| ch == '"' || ch.is_control())
    {
        return Err("当前程序路径不是安全的绝对文件路径。".to_owned());
    }
    let command = format!("\"{text}\"");
    if command.encode_utf16().count() > MAX_RUN_COMMAND_UNITS {
        return Err("当前程序路径超过 Windows 登录启动项的长度限制。".to_owned());
    }
    Ok(command)
}

/// Deliberately exact: an unquoted path, extra arguments, another installation,
/// environment expansion or a differently spelled path is not ours to delete.
fn matches_command(value: &str, command: &str) -> bool {
    value == command
}

trait Registry {
    fn read(&mut self) -> Result<Option<String>>;
    /// Re-read immediately before mutation and refuse a changed value. Run has
    /// no atomic compare-and-swap API; this also avoids clobbering edits made
    /// since the UI last read it. Only our exact value/name is ever targeted.
    fn replace(&mut self, expected: Option<&str>, replacement: Option<&str>) -> Result<()>;
}

fn describe(value: Result<Option<String>>, command: &str) -> Status {
    match value {
        Ok(None) => Status {
            enabled: Some(false),
            error: None,
        },
        Ok(Some(value)) if matches_command(&value, command) => Status {
            enabled: Some(true),
            error: None,
        },
        Ok(Some(_)) => Status::unknown(CONFLICT),
        Err(error) => Status::unknown(&error),
    }
}

fn toggle_registry(registry: &mut impl Registry, command: &str) -> Status {
    let before = match registry.read() {
        Ok(value) => value,
        Err(error) => return Status::unknown(&error),
    };
    let enable = match before.as_deref() {
        None => true,
        Some(value) if matches_command(value, command) => false,
        Some(_) => return Status::unknown(CONFLICT),
    };
    let result = registry.replace(before.as_deref(), enable.then_some(command));
    // Never infer success from RegSetValue/RegDeleteValue returning success:
    // display what is actually present, including after a failed write.
    let mut status = describe(registry.read(), command);
    match result {
        Err(error) => {
            status.error = Some(match status.error {
                Some(read_error) => format!("{error} {read_error}"),
                None => error,
            });
        }
        Ok(()) if status.enabled != Some(enable) => {
            if status.error.is_none() {
                status.error = Some("系统未保留登录启动项变更，请重新打开菜单确认。".to_owned());
            }
        }
        Ok(()) => {}
    }
    status
}

fn current_command() -> Result<String> {
    let path = std::env::current_exe().map_err(|_| "无法取得当前程序的绝对路径。".to_owned())?;
    command_for_exe(&path)
}

/// Read-only; a missing Run key/value stays missing.
pub(crate) fn status() -> Status {
    let command = match current_command() {
        Ok(command) => command,
        Err(error) => return Status::unknown(&error),
    };
    #[cfg(windows)]
    return describe(native::RunRegistry.read(), &command);
    #[cfg(not(windows))]
    {
        let _ = command;
        Status::unknown("登录自启仅支持 Windows。")
    }
}

/// The only production entry point that may write, called by the tray action.
pub(crate) fn toggle() -> Status {
    let command = match current_command() {
        Ok(command) => command,
        Err(error) => return Status::unknown(&error),
    };
    #[cfg(windows)]
    return toggle_registry(&mut native::RunRegistry, &command);
    #[cfg(not(windows))]
    {
        let _ = command;
        Status::unknown("登录自启仅支持 Windows。")
    }
}

#[cfg(windows)]
mod native {
    use super::*;
    use std::ptr::{null, null_mut};
    use windows_sys::Win32::Foundation::{
        ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND, ERROR_SUCCESS,
    };
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegQueryValueExW,
        RegSetValueExW, HKEY, HKEY_CURRENT_USER, KEY_QUERY_VALUE, KEY_SET_VALUE,
        REG_OPTION_NON_VOLATILE, REG_SZ,
    };

    struct Key(HKEY);

    impl Drop for Key {
        fn drop(&mut self) {
            unsafe { RegCloseKey(self.0) };
        }
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn error(operation: &str, code: u32) -> String {
        // No registry data or executable paths in errors sent to the UI/log.
        format!("无法{operation}登录启动项（Windows 错误 {code}）。")
    }

    fn missing(code: u32) -> bool {
        matches!(code, ERROR_FILE_NOT_FOUND | ERROR_PATH_NOT_FOUND)
    }

    fn open(write: bool, create: bool) -> Result<Option<Key>> {
        let path = wide(RUN_KEY);
        let mut handle = null_mut();
        let access = KEY_QUERY_VALUE | if write { KEY_SET_VALUE } else { 0 };
        let code = unsafe {
            if create {
                RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    path.as_ptr(),
                    0,
                    null(),
                    REG_OPTION_NON_VOLATILE,
                    access,
                    null(),
                    &mut handle,
                    null_mut(),
                )
            } else {
                RegOpenKeyExW(HKEY_CURRENT_USER, path.as_ptr(), 0, access, &mut handle)
            }
        };
        if missing(code) && !create {
            Ok(None)
        } else if code != ERROR_SUCCESS {
            Err(error("打开", code))
        } else if handle.is_null() {
            Err("无法取得登录启动项的注册表句柄。".to_owned())
        } else {
            Ok(Some(Key(handle)))
        }
    }

    fn read_key(key: &Key) -> Result<Option<String>> {
        let name = wide(VALUE_NAME);
        let mut kind = 0;
        let mut bytes = 0;
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                null(),
                &mut kind,
                null_mut(),
                &mut bytes,
            )
        };
        if code == ERROR_FILE_NOT_FOUND {
            return Ok(None);
        }
        if code != ERROR_SUCCESS {
            return Err(error("读取", code));
        }
        if kind != REG_SZ || bytes < 2 || bytes % 2 != 0 || bytes as usize > MAX_REG_SZ_UNITS * 2 {
            return Err("登录启动项的类型或长度异常，未作修改。".to_owned());
        }
        let mut units = vec![0u16; bytes as usize / 2];
        let capacity = bytes;
        let code = unsafe {
            RegQueryValueExW(
                key.0,
                name.as_ptr(),
                null(),
                &mut kind,
                units.as_mut_ptr().cast(),
                &mut bytes,
            )
        };
        if code != ERROR_SUCCESS {
            return Err(error("读取", code));
        }
        if kind != REG_SZ || bytes < 2 || bytes % 2 != 0 || bytes > capacity {
            return Err("登录启动项在读取时发生变化，请重试。".to_owned());
        }
        units.truncate(bytes as usize / 2);
        if units.pop() != Some(0) || units.contains(&0) {
            return Err("登录启动项不是有效的单个字符串，未作修改。".to_owned());
        }
        String::from_utf16(&units)
            .map(Some)
            .map_err(|_| "登录启动项包含无效字符，未作修改。".to_owned())
    }

    pub(super) struct RunRegistry;

    impl Registry for RunRegistry {
        fn read(&mut self) -> Result<Option<String>> {
            match open(false, false)? {
                Some(key) => read_key(&key),
                None => Ok(None),
            }
        }

        fn replace(&mut self, expected: Option<&str>, replacement: Option<&str>) -> Result<()> {
            // Only enabling may create the Run key; reading/disabling never do.
            let key = open(true, replacement.is_some())?.ok_or_else(|| CHANGED.to_owned())?;
            if read_key(&key)?.as_deref() != expected {
                return Err(CHANGED.to_owned());
            }
            let name = wide(VALUE_NAME);
            let code = unsafe {
                match replacement {
                    Some(command) => {
                        let units = wide(command);
                        RegSetValueExW(
                            key.0,
                            name.as_ptr(),
                            0,
                            REG_SZ,
                            units.as_ptr().cast(),
                            (units.len() * 2) as u32,
                        )
                    }
                    None => RegDeleteValueW(key.0, name.as_ptr()),
                }
            };
            if code == ERROR_SUCCESS {
                Ok(())
            } else {
                Err(error("修改", code))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn command() -> String {
        command_for_exe(Path::new(r"C:\Program Files\Pi Launcher\启动器.exe")).unwrap()
    }

    #[test]
    fn command_quotes_one_absolute_executable_without_arguments() {
        assert_eq!(command(), "\"C:\\Program Files\\Pi Launcher\\启动器.exe\"");
        assert_eq!(
            command_for_exe(Path::new(
                r"C:\Program Files\Pi Launcher\pi-launcher-tauri.exe"
            ))
            .unwrap(),
            "\"C:\\Program Files\\Pi Launcher\\pi-launcher-tauri.exe\""
        );
        assert_eq!(
            command_for_exe(Path::new(r"\\server\share\Pi Launcher.exe")).unwrap(),
            "\"\\\\server\\share\\Pi Launcher.exe\""
        );
        // Metacharacters remain literal filename characters, never shell input.
        assert!(command_for_exe(Path::new(r"C:\A & B\100% launcher.exe")).is_ok());
    }

    #[test]
    fn command_rejects_relative_ambiguous_or_injectable_paths() {
        for path in [
            "launcher.exe",
            r"C:launcher.exe",
            r"\launcher.exe",
            "C:\\launcher.exe\" --other-command",
            "C:\\launcher\0.exe",
            "C:\\launcher\n.exe",
            "C:\\launcher\r.exe",
            "C:\\launcher\t.exe",
            "C:\\launcher\u{1b}.exe",
            "C:\\directory\\",
            "C:\\directory/",
        ] {
            assert!(command_for_exe(Path::new(path)).is_err(), "{path:?}");
        }
        assert!(command_for_exe(Path::new(&format!("C:\\{}.exe", "a".repeat(260)))).is_err());
    }

    #[test]
    fn command_limit_counts_utf16_including_quotes_not_nul() {
        let exact = format!("C:\\{}.exe", "a".repeat(251));
        assert_eq!(
            command_for_exe(Path::new(&exact))
                .unwrap()
                .encode_utf16()
                .count(),
            260
        );
        let too_long = format!("C:\\{}.exe", "a".repeat(252));
        assert!(command_for_exe(Path::new(&too_long)).is_err());
        // Each supplementary character is two UTF-16 units, not one character.
        let exact_unicode = format!("C:\\{}a.exe", "🚀".repeat(125));
        assert_eq!(
            command_for_exe(Path::new(&exact_unicode))
                .unwrap()
                .encode_utf16()
                .count(),
            260
        );
        let too_long_unicode = format!("C:\\{}aa.exe", "🚀".repeat(125));
        assert!(command_for_exe(Path::new(&too_long_unicode)).is_err());
    }

    #[test]
    fn matching_never_claims_other_paths_or_arguments() {
        let ours = command();
        assert!(matches_command(&ours, &ours));
        for other in [
            ours.trim_matches('"').to_owned(),
            format!("{ours} --minimized"),
            format!(" {ours}"),
            "\"C:\\Other\\Pi Launcher.exe\"".to_owned(),
            "\"%LOCALAPPDATA%\\Pi Launcher.exe\"".to_owned(),
            ours.to_lowercase(),
        ] {
            assert!(!matches_command(&other, &ours), "{other}");
        }
    }

    #[derive(Default)]
    struct MockRegistry {
        value: Option<String>,
        read_error: bool,
        write_error: bool,
        change_before_write: Option<String>,
        unreadable_after_write: bool,
        discard_write: bool,
        mutations: usize,
    }

    impl Registry for MockRegistry {
        fn read(&mut self) -> Result<Option<String>> {
            if self.read_error {
                Err("模拟读取失败".to_owned())
            } else {
                Ok(self.value.clone())
            }
        }

        fn replace(&mut self, expected: Option<&str>, replacement: Option<&str>) -> Result<()> {
            if let Some(other) = self.change_before_write.take() {
                self.value = Some(other);
            }
            if self.value.as_deref() != expected {
                return Err(CHANGED.to_owned());
            }
            if self.write_error {
                return Err("模拟写入失败".to_owned());
            }
            self.mutations += 1;
            if !self.discard_write {
                self.value = replacement.map(str::to_owned);
            }
            if self.unreadable_after_write {
                self.read_error = true;
            }
            Ok(())
        }
    }

    #[test]
    fn reading_absence_does_not_create_or_enable_anything() {
        let mut registry = MockRegistry::default();
        assert_eq!(describe(registry.read(), &command()).enabled, Some(false));
        assert_eq!(registry.mutations, 0);
        assert_eq!(registry.value, None);
    }

    #[test]
    fn toggle_enables_then_disables_only_our_exact_command() {
        let mut registry = MockRegistry::default();
        let ours = command();
        let enabled = toggle_registry(&mut registry, &ours);
        assert_eq!(enabled.enabled, Some(true));
        assert_eq!(enabled.error, None);
        assert_eq!(registry.value.as_deref(), Some(ours.as_str()));
        let disabled = toggle_registry(&mut registry, &ours);
        assert_eq!(disabled.enabled, Some(false));
        assert_eq!(disabled.error, None);
        assert_eq!(registry.value, None);
        assert_eq!(registry.mutations, 2);
    }

    #[test]
    fn conflict_and_read_failure_disable_the_switch_without_writing() {
        for mut registry in [
            MockRegistry {
                value: Some("foreign command".to_owned()),
                ..Default::default()
            },
            MockRegistry {
                read_error: true,
                ..Default::default()
            },
        ] {
            let original = registry.value.clone();
            let status = toggle_registry(&mut registry, &command());
            assert_eq!(status.enabled, None);
            assert!(status.error.is_some());
            assert_eq!(registry.value, original);
            assert_eq!(registry.mutations, 0);
        }
    }

    #[test]
    fn failed_enable_and_disable_report_the_actual_state() {
        let ours = command();
        for original in [None, Some(ours.clone())] {
            let mut registry = MockRegistry {
                value: original.clone(),
                write_error: true,
                ..Default::default()
            };
            let status = toggle_registry(&mut registry, &ours);
            assert_eq!(status.enabled, Some(original.is_some()));
            assert!(status.error.as_deref().unwrap().contains("写入失败"));
            assert_eq!(registry.value, original);
            assert_eq!(registry.mutations, 0);
        }
    }

    #[test]
    fn concurrent_foreign_edit_is_not_deleted_or_overwritten() {
        let ours = command();
        for original in [None, Some(ours.clone())] {
            let mut registry = MockRegistry {
                value: original,
                change_before_write: Some("foreign command".to_owned()),
                ..Default::default()
            };
            let status = toggle_registry(&mut registry, &ours);
            assert_eq!(status.enabled, None);
            assert!(status.error.is_some());
            assert_eq!(registry.value.as_deref(), Some("foreign command"));
            assert_eq!(registry.mutations, 0);
        }
    }

    #[test]
    fn successful_write_followed_by_read_failure_never_fakes_a_state() {
        let mut registry = MockRegistry {
            unreadable_after_write: true,
            ..Default::default()
        };
        let status = toggle_registry(&mut registry, &command());
        assert_eq!(status.enabled, None);
        assert!(status.error.is_some());
    }

    #[test]
    fn successful_write_not_retained_is_not_reported_as_success() {
        let mut registry = MockRegistry {
            discard_write: true,
            ..Default::default()
        };
        let status = toggle_registry(&mut registry, &command());
        assert_eq!(status.enabled, Some(false));
        assert!(status.error.is_some());
    }
}
