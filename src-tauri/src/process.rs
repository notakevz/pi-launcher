//! Process inspection, termination and lifetime containment.
//!
//! Ownership is proven by PID + creation time + executable + full command line
//! before anything is ever terminated. External services are never touched.
//!
//! Everything here uses Win32 directly. The previous implementation shelled out
//! to `powershell -Command Get-CimInstance Win32_Process`, which costs 1.2-2.1 s
//! per call (PowerShell startup + WMI round trip) and used to sit right in the
//! middle of the cold-start path. `NtQueryInformationProcess` and
//! `GetProcessTimes` answer the same questions in microseconds.

use std::ffi::c_void;
use std::path::PathBuf;
use std::process::{Command, Output, Stdio};

use serde::{Deserialize, Serialize};

use windows_sys::Wdk::System::Threading::{NtQueryInformationProcess, PROCESSINFOCLASS};
use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, GlobalFree, FILETIME, HANDLE, HWND, WAIT_OBJECT_0, WAIT_TIMEOUT,
};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
    JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
    TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
use windows_sys::Win32::System::Ole::CF_UNICODETEXT;
use windows_sys::Win32::System::Registry::{RegGetValueW, HKEY_CURRENT_USER, RRF_RT_REG_DWORD};
use windows_sys::Win32::System::Threading::{
    GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, WaitForSingleObject,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    IsWindow, MessageBoxW, MB_ICONERROR, MB_OK, MB_SETFOREGROUND,
};

use crate::util::{creation_times_match, err, iso_from_filetime, Result};

/// `ProcessCommandLineInformation` — undocumented but stable since Windows 8.1.
const PROCESS_COMMAND_LINE_INFORMATION: PROCESSINFOCLASS = 60;
/// `ERROR_INVALID_PARAMETER`: the PID does not exist (any more).
const ERROR_INVALID_PARAMETER: u32 = 87;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProcessInfo {
    pub pid: u32,
    #[serde(default)]
    pub executable: Option<String>,
    #[serde(rename = "commandLine", default)]
    pub command_line: Option<String>,
    #[serde(default)]
    pub created: Option<String>,
    // Ownership-record extras, absent in a fresh query.
    #[serde(default)]
    pub version: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub entry: Option<String>,
}

fn hide_window(command: &mut Command) -> &mut Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

/// A child process with no console window, used for Node and PowerShell probes.
pub(crate) fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    hide_window(&mut command);
    command
}

/// `UNICODE_STRING` as returned by `NtQueryInformationProcess`: the buffer
/// pointer points into the caller-supplied block, not to the block itself.
#[repr(C)]
struct UnicodeString {
    length: u16,
    maximum_length: u16,
    buffer: *const u16,
}

pub fn inspect_process(pid: u32) -> Result<Option<ProcessInfo>> {
    if pid == 0 {
        return Ok(None);
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return match GetLastError() {
                // Process vanished between the caller's decision and now.
                ERROR_INVALID_PARAMETER => Ok(None),
                _ => Err(err("无法打开进程（权限不足或进程已退出）。")),
            };
        }
        let info = (|| -> Result<ProcessInfo> {
            let created = creation_time(handle).ok_or_else(|| err("无法读取进程创建时间。"))?;
            Ok(ProcessInfo {
                pid,
                executable: image_path(handle),
                command_line: command_line(handle),
                created: Some(created),
                version: None,
                label: None,
                entry: None,
            })
        })();
        CloseHandle(handle);
        info.map(Some)
    }
}

unsafe fn creation_time(handle: HANDLE) -> Option<String> {
    let mut creation = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut exit = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut kernel = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let mut user = FILETIME {
        dwLowDateTime: 0,
        dwHighDateTime: 0,
    };
    let ok = GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user);
    if ok == 0 {
        return None;
    }
    let ticks = ((creation.dwHighDateTime as u64) << 32) | creation.dwLowDateTime as u64;
    Some(iso_from_filetime(ticks))
}

unsafe fn image_path(handle: HANDLE) -> Option<String> {
    let mut buffer = [0u16; 1024];
    let mut size = buffer.len() as u32;
    // 0 == PROCESS_NAME_WIN32, i.e. the Win32 path rather than the NT one.
    let ok = QueryFullProcessImageNameW(handle, 0, buffer.as_mut_ptr(), &mut size);
    if ok == 0 {
        return None;
    }
    Some(String::from_utf16_lossy(&buffer[..size as usize]))
}

unsafe fn command_line(handle: HANDLE) -> Option<String> {
    let mut needed: u32 = 0;
    // First call sizes the buffer; STATUS_INFO_LENGTH_MISMATCH is expected.
    NtQueryInformationProcess(
        handle,
        PROCESS_COMMAND_LINE_INFORMATION,
        std::ptr::null_mut(),
        0,
        &mut needed,
    );
    if needed == 0 {
        return None;
    }
    // u64 backing keeps the 8-byte alignment UNICODE_STRING requires.
    let mut storage = vec![0u64; (needed as usize).div_ceil(8)];
    let status = NtQueryInformationProcess(
        handle,
        PROCESS_COMMAND_LINE_INFORMATION,
        storage.as_mut_ptr() as *mut c_void,
        needed,
        &mut needed,
    );
    if status < 0 {
        return None;
    }
    let text = &*(storage.as_ptr() as *const UnicodeString);
    if text.buffer.is_null() || text.length == 0 {
        return None;
    }
    let units = std::slice::from_raw_parts(text.buffer, (text.length / 2) as usize);
    Some(String::from_utf16_lossy(units))
}

/// Run a command with a hard time limit, returning its output.
///
/// Both callers (`node --version`, `taskkill`) used to be unbounded `.output()`
/// calls on the startup/quit path. A shim on a disconnected network drive, or an
/// AV scanner holding the image, was enough to hang the launcher on the loading
/// page forever — `startupTimeoutMs` could not help, because the timeout was
/// never reached.
pub fn output_within(mut command: Command, budget: std::time::Duration) -> Result<Output> {
    use std::time::Instant;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| err(format!("无法运行命令：{error}")))?;
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {}
            Err(error) => return Err(err(format!("等待命令退出失败：{error}"))),
        }
        if started.elapsed() >= budget {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err(format!(
                "命令在 {} ms 内没有结束，已终止。",
                budget.as_millis()
            )));
        }
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    child
        .wait_with_output()
        .map_err(|error| err(format!("读取命令输出失败：{error}")))
}

pub fn stop_process_tree(info: &ProcessInfo) -> Result<()> {
    let created = info
        .created
        .as_deref()
        .ok_or_else(|| err("进程记录缺少创建时间，拒绝终止进程。"))?;
    // Re-verify before killing: the record may be stale and the PID reused.
    let Some(current) = inspect_process(info.pid)? else {
        return Ok(());
    };
    if !creation_times_match(current.created.as_deref(), Some(created)) {
        return Err(err("进程创建时间与记录不符，拒绝终止进程。"));
    }
    // A caller's verified snapshot must still describe the same executable and
    // command, not merely a PID/time pair. Missing identity is never permission.
    if !matches!((&info.executable, &current.executable), (Some(a), Some(b)) if a.eq_ignore_ascii_case(b))
        || !matches!((&info.command_line, &current.command_line), (Some(a), Some(b)) if a == b)
    {
        return Err(err("进程路径或命令行与记录不符，拒绝终止进程。"));
    }
    // taskkill handles the whole tree (Node may have grandchildren) in ~80 ms,
    // without paying for a PowerShell host.
    let taskkill = std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("C:\\Windows"))
        .join("System32")
        .join("taskkill.exe");
    let output = output_within(
        {
            let mut command = hidden_command(&taskkill);
            command.args(["/pid", &info.pid.to_string(), "/t", "/f"]);
            command
        },
        std::time::Duration::from_secs(5),
    )?;
    if !output.status.success() {
        return Err(err(format!(
            "taskkill 失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    wait_for_completion(|| process_has_exited(info))
}

/// Probe the original identity, not just whether a (possibly reused) PID exists.
/// Query failures are unknown, never evidence that cleanup succeeded.
pub fn process_has_exited(info: &ProcessInfo) -> Result<bool> {
    unsafe {
        let handle = OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            0,
            info.pid,
        );
        if handle.is_null() {
            return if GetLastError() == ERROR_INVALID_PARAMETER && info.pid != 0 {
                Ok(true)
            } else {
                Err(err("无法验证进程是否已退出。"))
            };
        }
        let result = (|| {
            let created = creation_time(handle).ok_or_else(|| err("无法验证进程创建时间。"))?;
            if !creation_times_match(info.created.as_deref(), Some(&created)) {
                // Reject malformed snapshots; a valid but different time means
                // the original process is gone. Never terminate this new PID.
                if !creation_times_match(info.created.as_deref(), info.created.as_deref()) {
                    return Err(err("进程记录创建时间无效。"));
                }
                return Ok(true);
            }
            match WaitForSingleObject(handle, 0) {
                WAIT_OBJECT_0 => Ok(true),
                WAIT_TIMEOUT => Ok(false),
                _ => Err(err("无法等待进程退出。")),
            }
        })();
        CloseHandle(handle);
        result
    }
}

pub(crate) fn wait_for_completion(mut complete: impl FnMut() -> Result<bool>) -> Result<()> {
    let started = std::time::Instant::now();
    loop {
        if complete()? {
            return Ok(());
        }
        if started.elapsed() >= std::time::Duration::from_millis(1500) {
            return Err(err("等待后端进程退出超时；保留所有权记录以便重试。"));
        }
        crate::util::sleep(20);
    }
}

/// Job object that owns the backend process tree.
///
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` means the backend dies with the
/// launcher even on a crash or a Task Manager kill, so the next start never has
/// to adopt (and verify) a leftover process. Closing the handle kills the tree.
pub struct JobHandle(HANDLE);

// The handle is only ever used through kernel calls, which are thread-safe.
unsafe impl Send for JobHandle {}
unsafe impl Sync for JobHandle {}

impl JobHandle {
    pub fn create() -> Option<Self> {
        unsafe {
            let handle = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if handle.is_null() {
                return None;
            }
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                CloseHandle(handle);
                return None;
            }
            Some(Self(handle))
        }
    }

    pub fn assign(&self, pid: u32) -> bool {
        unsafe {
            let process = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
            if process.is_null() {
                return false;
            }
            let ok = AssignProcessToJobObject(self.0, process);
            CloseHandle(process);
            ok != 0
        }
    }

    /// Terminate every process in the job. Cheaper than taskkill and cannot be
    /// raced by a PID being reused.
    pub fn terminate(&self) -> Result<()> {
        if unsafe { TerminateJobObject(self.0, 1) } == 0 {
            return Err(err(format!("TerminateJobObject 失败：{}", unsafe {
                GetLastError()
            })));
        }
        wait_for_completion(|| self.is_empty())
    }

    pub fn is_empty(&self) -> Result<bool> {
        unsafe {
            let mut accounting: JOBOBJECT_BASIC_ACCOUNTING_INFORMATION = std::mem::zeroed();
            if QueryInformationJobObject(
                self.0,
                JobObjectBasicAccountingInformation,
                &mut accounting as *mut _ as *mut c_void,
                std::mem::size_of_val(&accounting) as u32,
                std::ptr::null_mut(),
            ) == 0
            {
                return Err(err("无法验证 Job Object 内的进程是否已退出。"));
            }
            Ok(accounting.ActiveProcesses == 0)
        }
    }
}

impl Drop for JobHandle {
    fn drop(&mut self) {
        unsafe {
            CloseHandle(self.0);
        }
    }
}

/// NUL-terminated UTF-16, the form every Win32 `...W` entry point expects.
fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Write text to the clipboard through the Win32 clipboard API.
///
/// This used to spawn `powershell -Command Set-Clipboard`, which measured
/// 0.98–1.19 s. The call sits in the tray popover's `on_new_window` handler,
/// i.e. on the event-loop thread, so every "复制地址" click froze the whole
/// application for about a second.
pub(crate) fn set_clipboard(owner: HWND, text: &str) -> bool {
    unsafe {
        // EmptyClipboard with a NULL owner makes SetClipboardData fail. Reject
        // invalid owners *before* touching the user's global clipboard.
        if owner.is_null() || IsWindow(owner) == 0 {
            return false;
        }
        let units = wide(text);
        let bytes = units.len() * std::mem::size_of::<u16>();
        let block = GlobalAlloc(GMEM_MOVEABLE, bytes);
        if block.is_null() {
            return false;
        }
        let target = GlobalLock(block);
        if target.is_null() {
            GlobalFree(block);
            return false;
        }
        std::ptr::copy_nonoverlapping(units.as_ptr(), target as *mut u16, units.len());
        GlobalUnlock(block);
        // Allocate and fill first: allocation/locking failures must not erase
        // existing clipboard contents.
        if OpenClipboard(owner) == 0 {
            GlobalFree(block);
            return false;
        }
        if EmptyClipboard() == 0 {
            GlobalFree(block);
            CloseClipboard();
            return false;
        }
        // On success the clipboard owns the block; freeing it would leave a
        // dangling handle behind.
        if SetClipboardData(CF_UNICODETEXT as u32, block).is_null() {
            GlobalFree(block);
            CloseClipboard();
            return false;
        }
        CloseClipboard();
        true
    }
}

/// Native message box, drawn by `user32` in about a millisecond.
///
/// Returns false when Windows refused to display it. The previous version ran
/// the dialog through `Add-Type -AssemblyName System.Windows.Forms`, which cost
/// ~0.8 s just to start PowerShell and produced *no dialog at all* on machines
/// where AppLocker/WDAC puts PowerShell into ConstrainedLanguage mode — the one
/// situation where the user most needs to be told what went wrong.
/// Whether Windows is configured for dark app mode.
///
/// Used to paint the window (and therefore WebView2's surface before the first
/// document frame) in the loading page's own background colour, so startup does
/// not flash white in either theme. Read straight from the registry: a wrong
/// answer costs one frame of the wrong shade, so a synchronous ~10 µs read is
/// better value than another dependency or an async theme event.
pub fn prefers_dark() -> bool {
    let subkey = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let value = wide("AppsUseLightTheme");
    let mut light: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            subkey.as_ptr(),
            value.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            &mut light as *mut u32 as *mut c_void,
            &mut size,
        )
    };
    // Anything unexpected (missing value, denied key) keeps the light default.
    status == 0 && light == 0
}

pub(crate) fn show_message_box(title: &str, message: &str) -> bool {
    let caption = wide(title);
    let body = wide(message);
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            body.as_ptr(),
            caption.as_ptr(),
            MB_OK | MB_ICONERROR | MB_SETFOREGROUND,
        ) != 0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::System::DataExchange::GetClipboardData;

    /// These opt-in tests overwrite the real clipboard (including non-text
    /// formats). Never run them in automated validation or a user's session.
    static CLIPBOARD: std::sync::Mutex<()> = std::sync::Mutex::new(());

    struct ClipboardOwner(HWND);

    impl ClipboardOwner {
        fn new() -> Self {
            use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, HWND_MESSAGE};
            let class = wide("STATIC");
            let hwnd = unsafe {
                CreateWindowExW(
                    0,
                    class.as_ptr(),
                    std::ptr::null(),
                    0,
                    0,
                    0,
                    0,
                    0,
                    HWND_MESSAGE,
                    std::ptr::null_mut(),
                    std::ptr::null_mut(),
                    std::ptr::null(),
                )
            };
            assert!(!hwnd.is_null(), "create message-only clipboard owner");
            Self(hwnd)
        }
    }

    impl Drop for ClipboardOwner {
        fn drop(&mut self) {
            unsafe {
                windows_sys::Win32::UI::WindowsAndMessaging::DestroyWindow(self.0);
            }
        }
    }

    /// Read back whatever is on the clipboard right now, as text.
    fn clipboard_text() -> Option<String> {
        unsafe {
            if OpenClipboard(std::ptr::null_mut()) == 0 {
                return None;
            }
            let handle = GetClipboardData(CF_UNICODETEXT as u32);
            if handle.is_null() {
                CloseClipboard();
                return None;
            }
            let pointer = GlobalLock(handle) as *const u16;
            if pointer.is_null() {
                CloseClipboard();
                return None;
            }
            let mut length = 0usize;
            while *pointer.add(length) != 0 {
                length += 1;
            }
            let text = String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length));
            GlobalUnlock(handle);
            CloseClipboard();
            Some(text)
        }
    }

    #[test]
    #[ignore = "overwrites the real system clipboard; manual isolated desktop only"]
    fn clipboard_round_trip() {
        let _guard = CLIPBOARD.lock().unwrap_or_else(|p| p.into_inner());
        let owner = ClipboardOwner::new();
        let sample = "pi-launcher clipboard test 喵 \"quoted\" \\path";
        assert!(
            set_clipboard(owner.0, sample),
            "set_clipboard reported failure"
        );
        assert_eq!(clipboard_text().as_deref(), Some(sample));
    }

    #[test]
    #[ignore = "overwrites the real system clipboard; manual isolated desktop only"]
    fn clipboard_handles_multiline_and_empty() {
        let _guard = CLIPBOARD.lock().unwrap_or_else(|p| p.into_inner());
        let owner = ClipboardOwner::new();
        assert!(set_clipboard(owner.0, "line1\r\nline2\r\n"));
        assert_eq!(clipboard_text().as_deref(), Some("line1\r\nline2\r\n"));
        assert!(set_clipboard(owner.0, ""));
        assert_eq!(clipboard_text().as_deref(), Some(""));
    }

    #[test]
    fn utf16_text_has_one_terminator() {
        assert_eq!(wide(""), vec![0]);
        assert_eq!(wide("喵\n"), vec![0x55b5, 10, 0]);
    }
}
