//! Backend lifecycle: reuse, start, verify ownership, stop.
//! No downloads, no staging, no version switching.

use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::Value;

use crate::config::{read_config, require_backend_path, validate_proxy_url, Config};
use crate::http::{check_ready_within, check_server, is_port_free, FIRST_REQUEST_TIMEOUT};
use crate::process::{
    inspect_process, process_has_exited, stop_process_tree, wait_for_completion, JobHandle,
    ProcessInfo,
};
use crate::util::{
    command_has_path, command_has_port, creation_times_match, err, log, log_error, sleep, Error,
    Result, HOST,
};

pub struct BackendSpec {
    pub root: PathBuf,
    pub entry: PathBuf,
    pub version: String,
    pub label: String,
}

#[derive(Clone, Debug)]
pub struct ServerInfo {
    pub url: String,
    pub owned: bool,
    pub info: Option<ProcessInfo>,
    pub version: Option<String>,
    pub label: Option<String>,
}

pub struct PiBackend {
    state_dir: PathBuf,
    pub config: Config,
    node: Option<PathBuf>,
    env: HashMap<String, String>,
    closed: Arc<AtomicBool>,
    /// Shared with the exit watcher instead of being moved into it: a `Child`
    /// that only the watcher owns cannot be killed any more, which used to turn
    /// a missing/stale record file into a permanently orphaned backend.
    child: Arc<Mutex<Option<Child>>>,
    /// PID of the child we spawned; `None` when an external server was adopted.
    child_pid: Option<u32>,
    /// Verified while the child handle is still ours; survives missing records.
    child_info: Option<ProcessInfo>,
    /// Keeps the backend tree alive only as long as the launcher lives.
    job: Option<JobHandle>,
    output_tail: Arc<Mutex<String>>,
}

impl PiBackend {
    pub fn new(state_dir: PathBuf, closed: Arc<AtomicBool>) -> Result<Self> {
        let config = read_config(&state_dir)?;
        let env = server_environment(&config)?;
        Ok(Self {
            state_dir,
            config,
            node: None,
            env,
            closed,
            child: Arc::new(Mutex::new(None)),
            child_pid: None,
            child_info: None,
            job: None,
            output_tail: Arc::new(Mutex::new(String::new())),
        })
    }

    pub fn port(&self) -> u16 {
        self.config.port_u16()
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::SeqCst)
    }

    /// Whether this launcher spawned the backend, as opposed to adopting an
    /// already-running one.
    pub fn spawned(&self) -> bool {
        self.child_pid.is_some()
    }

    /// Handle the exit watcher polls. The `Child` stays owned by the backend so
    /// `stop()` can always kill it, even when the record file is gone.
    pub fn child_handle(&self) -> Arc<Mutex<Option<Child>>> {
        self.child.clone()
    }

    /// Last-line fallback uses our retained OS handle, never a fresh PID query.
    /// Do not wait unboundedly (or hold the watcher's mutex while waiting).
    fn kill_child(&self) -> Result<()> {
        {
            let mut guard = crate::util::lock(&self.child);
            if let Some(child) = guard.as_mut() {
                if child.try_wait()?.is_none() {
                    child.kill()?;
                }
            }
        }
        wait_for_completion(|| self.child_has_exited())
    }

    fn child_has_exited(&self) -> Result<bool> {
        let mut guard = crate::util::lock(&self.child);
        match guard.as_mut() {
            Some(child) => Ok(child.try_wait()?.is_some()),
            None => Ok(true),
        }
    }

    fn record_path(&self, port: u16) -> PathBuf {
        self.state_dir.join(format!("pi-web-{port}.json"))
    }

    fn resolve_node(&self) -> Result<PathBuf> {
        let mut candidates: Vec<PathBuf> = Vec::new();
        if let Some(explicit) = self.env.get("PI_LAUNCHER_NODE") {
            candidates.push(PathBuf::from(explicit));
        } else {
            let path = self
                .env
                .get("PATH")
                .or_else(|| self.env.get("Path"))
                .cloned()
                .unwrap_or_default();
            for directory in path.split(';') {
                let clean = directory.trim().trim_matches('"');
                if !clean.is_empty() {
                    candidates.push(Path::new(clean).join("node.exe"));
                }
            }
            let program_files = self
                .env
                .get("PROGRAMFILES")
                .cloned()
                .unwrap_or_else(|| "C:\\Program Files".to_string());
            candidates.push(Path::new(&program_files).join("nodejs").join("node.exe"));
        }
        for candidate in candidates {
            if candidate.is_file() {
                // A single unreadable PATH entry (broken link, ACL, stale
                // %PATH% shim) must not abort the search for the others.
                let resolved = fs::canonicalize(&candidate).unwrap_or(candidate);
                return Ok(normalize_windows_path(resolved));
            }
        }
        Err(err(
            "找不到 Windows Node.js。请安装 Node.js 22.19 或更新版本。",
        ))
    }

    fn ensure_runtime(&mut self) -> Result<()> {
        let node = self.resolve_node()?;
        let version = self.node_version(&node)?;
        let mut parts = version.trim_start_matches('v').split('.');
        let major = parts.next().and_then(|v| v.parse::<u32>().ok());
        let minor = parts.next().and_then(|v| v.parse::<u32>().ok());
        let (major, minor) = match (major, minor) {
            (Some(a), Some(b)) => (a, b),
            _ => return Err(err(format!("无法识别 Node.js 版本：{version}"))),
        };
        if major < 22 || (major == 22 && minor < 19) {
            return Err(err(format!(
                "Node.js {version} 过旧，需要 22.19 或更新版本。"
            )));
        }
        log(
            &self.state_dir,
            &format!(
                "Native Node {version}; local backend={}; no downloads or updates",
                self.config.backend_path.as_deref().unwrap_or("(external)")
            ),
        );
        self.node = Some(node);
        Ok(())
    }

    /// `node --version` costs a process launch (tens of milliseconds, more while
    /// the binary is still being scanned). The answer only changes when the
    /// executable does, so it is cached against the file's size and mtime.
    fn node_version(&self, node: &Path) -> Result<String> {
        let metadata = fs::metadata(node)?;
        let length = metadata.len();
        let modified = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|elapsed| elapsed.as_secs())
            .unwrap_or(0);
        let path = node.to_string_lossy().into_owned();
        let cache_path = self.state_dir.join("node-runtime.json");

        if let Ok(text) = fs::read_to_string(&cache_path) {
            if let Ok(cached) = serde_json::from_str::<Value>(&text) {
                let matches = cached.get("path").and_then(Value::as_str) == Some(path.as_str())
                    && cached.get("length").and_then(Value::as_u64) == Some(length)
                    && cached.get("modified").and_then(Value::as_u64) == Some(modified);
                if matches {
                    if let Some(version) = cached.get("version").and_then(Value::as_str) {
                        log(
                            &self.state_dir,
                            &format!("Node version cached: {version} ({path})"),
                        );
                        return Ok(version.to_string());
                    }
                }
            }
        }

        let output = crate::process::output_within(
            {
                let mut command = crate::process::hidden_command(node);
                command.arg("--version");
                command
            },
            std::time::Duration::from_secs(5),
        )?;
        let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
        let record = serde_json::json!({
            "path": path,
            "length": length,
            "modified": modified,
            "version": version,
        });
        if let Ok(text) = serde_json::to_string(&record) {
            let _ = fs::write(&cache_path, text);
        }
        Ok(version)
    }

    fn is_server_process(&self, info: &ProcessInfo, port: u16, entry: &str) -> bool {
        let node = match &self.node {
            Some(node) => node.to_string_lossy().to_ascii_lowercase(),
            None => return false,
        };
        let executable = info
            .executable
            .as_deref()
            .map(|value| {
                fs::canonicalize(value)
                    .map(normalize_windows_path)
                    .map(|path| path.to_string_lossy().to_ascii_lowercase())
                    .unwrap_or_else(|_| value.to_ascii_lowercase())
            })
            .unwrap_or_default();
        if executable != node {
            return false;
        }
        let path = Path::new(entry);
        let valid_entry = path.is_absolute()
            && path
                .file_name()
                .map(|name| name == "pi-web.js")
                .unwrap_or(false)
            && path
                .parent()
                .and_then(|parent| parent.file_name())
                .map(|name| name == "bin")
                .unwrap_or(false);
        let command = info.command_line.as_deref().unwrap_or_default();
        valid_entry && command_has_path(command, entry) && command_has_port(command, port)
    }

    fn get_owned_process(&mut self, port: u16) -> Option<ProcessInfo> {
        let file = self.record_path(port);
        let text = match fs::read_to_string(&file) {
            Ok(text) => text,
            Err(error) => {
                if error.kind() != std::io::ErrorKind::NotFound {
                    log(
                        &self.state_dir,
                        &format!(
                            "Warning: 无法读取进程记录 {}；安全忽略，不会据此停止进程。",
                            file.display()
                        ),
                    );
                }
                return None;
            }
        };
        let record: ProcessInfo = match serde_json::from_str(&text) {
            Ok(record) => record,
            Err(_) => {
                log(
                    &self.state_dir,
                    &format!(
                        "Warning: 进程记录损坏 {}；安全忽略，不会据此停止进程。",
                        file.display()
                    ),
                );
                return None;
            }
        };
        let created = record.created.as_deref().unwrap_or_default();
        let entry = record.entry.as_deref().unwrap_or_default();
        if record.pid == 0 || created.is_empty() || !Path::new(entry).is_absolute() {
            log(
                &self.state_dir,
                &format!(
                    "Warning: 进程记录损坏 {}；安全忽略，不会据此停止进程。",
                    file.display()
                ),
            );
            return None;
        }
        if self.node.is_none() {
            match self.resolve_node() {
                Ok(node) => self.node = Some(node),
                Err(_) => {
                    log(
                        &self.state_dir,
                        "Warning: 无法验证记录的 Node 身份；按外部服务处理。",
                    );
                    return None;
                }
            }
        }
        let inspected = match inspect_process(record.pid) {
            Ok(Some(info)) => info,
            Ok(None) => {
                let _ = fs::remove_file(&file);
                return None;
            }
            Err(error) => {
                log_error(
                    &self.state_dir,
                    "Warning: 进程检查失败，按外部服务处理",
                    &error,
                );
                return None;
            }
        };
        if inspected.executable.is_none() || inspected.command_line.is_none() {
            log(
                &self.state_dir,
                "Warning: 无法读取进程路径或命令行；保留所有权记录。",
            );
            return None;
        }
        if creation_times_match(inspected.created.as_deref(), Some(created))
            && self.is_server_process(&inspected, port, entry)
        {
            return Some(ProcessInfo {
                version: record.version.clone(),
                label: record.label.clone(),
                entry: record.entry.clone(),
                ..inspected
            });
        }
        // Stale or foreign process: drop the record, never guess and kill it.
        let _ = fs::remove_file(&file);
        None
    }

    pub fn stop(&mut self, port: u16, expected: Option<&ProcessInfo>) -> Result<()> {
        let owned = self.get_owned_process(port);
        if let (Some(expected), Some(info)) = (expected, owned.as_ref()) {
            if info.pid != expected.pid
                || !creation_times_match(info.created.as_deref(), expected.created.as_deref())
            {
                return Ok(());
            }
        }
        // The record file carries the creation time used to re-verify the PID,
        // but it is still only a file: a cleaner can delete it, a crash can
        // leave it half-written, and an AV driver can deny the `OpenProcess`
        // that reading it requires. The caller's snapshot is the same data and
        // survives all three, so use it as the fallback identity.
        let target = owned
            .clone()
            .or_else(|| expected.cloned())
            .or_else(|| self.child_info.clone());
        if target.is_none() && self.child_pid.is_none() {
            // An unreadable/unverified record is not proof of ownership or exit.
            return Ok(());
        }
        cleanup_owned_process(
            || {
                if let Some(job) = self.job.as_ref().filter(|_| {
                    target
                        .as_ref()
                        .map(|info| Some(info.pid) == self.child_pid)
                        .unwrap_or(true)
                }) {
                    // This is our own job handle, safe even without a record.
                    job.terminate()
                } else if let Some(info) = &target {
                    stop_process_tree(info)
                } else {
                    Ok(())
                }
            },
            || self.kill_child(),
            || {
                wait_for_completion(|| {
                    let target_exited = match &target {
                        Some(info) if Some(info.pid) == self.child_pid => {
                            self.child_has_exited()?
                        }
                        Some(info) => process_has_exited(info)?,
                        None => true,
                    };
                    let job_empty = match &self.job {
                        Some(job) => job.is_empty()?,
                        None => true,
                    };
                    Ok(target_exited && job_empty && self.child_has_exited()?)
                })
            },
            || match fs::remove_file(self.record_path(port)) {
                Ok(()) => Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(error) => Err(error.into()),
            },
        )?;
        if let Some(info) = &target {
            log(
                &self.state_dir,
                &format!(
                    "Stopped launcher-owned Pi Web process tree pid={}",
                    info.pid
                ),
            );
        }
        Ok(())
    }

    /// Wait for a just-terminated backend to release its listening socket.
    ///
    /// `TerminateJobObject` returns before the kernel has torn down the child's
    /// sockets, so checking `is_port_free` immediately reported "port occupied"
    /// against the process we had just killed. That made a second start fail
    /// intermittently for no visible reason.
    fn wait_for_port_free(&self, port: u16, budget: std::time::Duration) -> bool {
        let started = Instant::now();
        loop {
            if is_port_free(port) {
                return true;
            }
            if started.elapsed() >= budget {
                return false;
            }
            sleep(20);
        }
    }

    fn write_record(&self, port: u16, info: &ProcessInfo) -> Result<()> {
        fs::create_dir_all(&self.state_dir)?;
        let target = self.record_path(port);
        let temporary = self.state_dir.join(format!(
            "pi-web-{port}.json.{}.{}.tmp",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let result = (|| -> Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)?;
            file.write_all(serde_json::to_string(info)?.as_bytes())?;
            file.flush()?;
            drop(file);
            if target.exists() {
                fs::remove_file(&target)?;
            }
            fs::rename(&temporary, &target)?;
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result
    }

    pub fn start(&mut self, port: u16) -> Result<ServerInfo> {
        if self.is_closed() {
            return Err(err("应用正在退出"));
        }
        let url = format!("http://{HOST}:{port}");
        let existing = self.get_owned_process(port);
        // Bind test first: it is instantaneous, whereas an HTTP probe against a
        // closed port burns the whole connect budget (150 ms here, ~2 s on
        // machines with a loopback filter driver). Nothing can be listening on
        // a port this process can bind, so the probe would only ever time out.
        let listening = if is_port_free(port) {
            false
        } else {
            check_server(&url, &self.closed)
        };
        // A backend that is still warming up (or busy serving a request) can
        // miss the probe budget without being broken. Killing it on the first
        // miss threw away a healthy instance and restarted from scratch, so
        // give our own recorded process a second chance before deciding.
        let listening = if listening || existing.is_none() {
            listening
        } else {
            let mut recovered = false;
            for _ in 0..2 {
                if self.is_closed() {
                    break;
                }
                sleep(300);
                if check_server(&url, &self.closed) {
                    recovered = true;
                    break;
                }
            }
            recovered
        };
        log(
            &self.state_dir,
            &format!(
                "Port probe: record={} listening={}",
                if existing.is_some() { "yes" } else { "no" },
                if listening { "yes" } else { "no" }
            ),
        );
        if listening {
            if let Some(info) = &existing {
                log(&self.state_dir, &format!("Adopted Pi Web pid={}", info.pid));
            } else {
                log(
                    &self.state_dir,
                    "Reusing external Pi Web; no version replacement or process ownership",
                );
            }
            return Ok(ServerInfo {
                url,
                owned: existing.is_some(),
                version: existing.as_ref().and_then(|v| v.version.clone()),
                label: existing.as_ref().and_then(|v| v.label.clone()),
                info: existing,
            });
        }
        if let Some(info) = &existing {
            self.stop(port, Some(info))?;
            if !self.wait_for_port_free(port, std::time::Duration::from_millis(1500)) {
                return Err(err(format!(
                    "端口 {port} 仍被上一个后端实例占用（pid={}）；请稍后重试。",
                    info.pid
                )));
            }
        }
        if !is_port_free(port) {
            return Err(err(format!(
                "端口 {port} 已被其他程序占用；不会停止该程序。"
            )));
        }
        let root = require_backend_path(self.config.backend_path.as_deref())?.to_string();
        let spec = inspect_backend(Path::new(&root))?;
        self.ensure_runtime()?;
        log(&self.state_dir, "Backend spec and Node runtime ready");
        if self.is_closed() {
            return Err(err("应用正在退出"));
        }

        log(
            &self.state_dir,
            &format!(
                "Starting local Pi Web {} directly from {}",
                spec.label,
                spec.root.display()
            ),
        );
        let node = self.node.clone().ok_or_else(|| err("Node.js 未就绪"))?;
        let mut command = crate::process::hidden_command(&node);
        command
            .arg(&spec.entry)
            .arg("--hostname")
            .arg(HOST)
            .arg("--port")
            .arg(port.to_string())
            .arg("--no-open")
            .current_dir(self.config.cwd.as_deref().unwrap_or_default())
            .env_clear()
            .envs(&self.env)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = command
            .spawn()
            .map_err(|error| Error(format!("无法启动 Pi Web 后端：{error}")))?;

        self.pipe_output(child.stdout.take(), child.stderr.take());
        let pid = child.id();
        *crate::util::lock(&self.child) = Some(child);
        self.child_pid = Some(pid);
        self.child_info = None;
        // Contain the tree: if the launcher dies (crash, Task Manager), the
        // backend goes with it instead of being adopted on the next start.
        match JobHandle::create() {
            Some(job) if job.assign(pid) => self.job = Some(job),
            Some(_) => log(
                &self.state_dir,
                "Warning: 无法把后端加入 Job Object；退出清理回退到 taskkill。",
            ),
            None => log(
                &self.state_dir,
                "Warning: 无法创建 Job Object；退出清理回退到 taskkill。",
            ),
        }
        log(&self.state_dir, &format!("Spawned Pi Web pid={pid}"));

        let result = self.await_backend(port, &spec);
        let state_dir = self.state_dir.clone();
        finish_start_attempt(
            result,
            || self.cleanup_failed_start(port),
            |error| {
                log_error(
                    &state_dir,
                    "Failed-start cleanup (ownership record retained)",
                    error,
                );
            },
        )
    }

    fn await_backend(&mut self, port: u16, spec: &BackendSpec) -> Result<ServerInfo> {
        let url = format!("http://{HOST}:{port}");
        let pid = self.child_pid.unwrap_or(0);
        // Win32 query, well under a millisecond. The old CIM probe both cost
        // 1.2-2.1 s and could miss a process that WMI had not published yet.
        let info = inspect_process(pid)?;
        let mut info = match info.filter(|candidate| {
            self.is_server_process(candidate, port, &spec.entry.to_string_lossy())
        }) {
            Some(info) => info,
            None => {
                return Err(err(format!(
                    "本地 Pi Web 未能启动：{}",
                    self.output_tail
                        .lock()
                        .map(|v| v.clone())
                        .unwrap_or_default()
                )))
            }
        };
        info.version = Some(spec.version.clone());
        info.label = Some(spec.label.clone());
        info.entry = Some(spec.entry.to_string_lossy().into_owned());
        self.child_info = Some(info.clone());
        self.write_record(port, &info)?;

        let started = Instant::now();
        let timeout = std::time::Duration::from_millis(self.config.startup_timeout_ms as u64);
        let mut last_check = String::from("(未执行)");
        let mut probes: u32 = 0;
        let mut http_probes: u32 = 0;
        let mut http_probe_time = std::time::Duration::from_millis(0);
        let mut listening_at: Option<std::time::Duration> = None;
        while started.elapsed() < timeout {
            if self.is_closed() {
                return Err(err("应用正在退出"));
            }
            // Locked only for the non-blocking probe: the exit watcher and
            // `stop()` need the same guard to kill the process.
            let exited = {
                let mut guard = crate::util::lock(&self.child);
                match guard.as_mut() {
                    Some(child) => child.try_wait()?,
                    None => None,
                }
            };
            if let Some(status) = exited {
                // The output pipe threads run on their own threads and write the
                // tail asynchronously, so reading it here used to produce an
                // empty message for the most common failure (a config error that
                // kills Node immediately). Give them a moment.
                for _ in 0..20 {
                    let has_output = self
                        .output_tail
                        .lock()
                        .map(|tail| !tail.is_empty())
                        .unwrap_or(false);
                    if has_output {
                        break;
                    }
                    sleep(25);
                }
                return Err(Error(format!(
                    "Pi Web exited ({})：{}",
                    status.code().unwrap_or(-1),
                    self.output_tail
                        .lock()
                        .map(|v| v.clone())
                        .unwrap_or_default()
                )));
            }
            probes += 1;
            // Gate on a bind test: it is free and instant, whereas a refused
            // loopback connect can take seconds on machines with a filter
            // driver. Only speak HTTP once something is actually listening.
            let listening = !is_port_free(port);
            if listening && listening_at.is_none() {
                listening_at = Some(started.elapsed());
            }
            // The first request a fresh backend serves is the expensive one, so
            // it gets a long read budget: abandoning it midway only makes the
            // server redo the work while readiness waits another round trip.
            // It must still fit inside the overall startup budget, or a small
            // `startupTimeoutMs` would silently turn into 30 s plus the rest.
            let remaining = timeout.saturating_sub(started.elapsed());
            if listening && remaining < std::time::Duration::from_millis(200) {
                break;
            }
            let budget = remaining.min(FIRST_REQUEST_TIMEOUT);
            let response = if listening {
                http_probes += 1;
                let probe_started = Instant::now();
                let attempt = check_ready_within(&url, budget, &self.closed);
                http_probe_time += probe_started.elapsed();
                attempt
            } else {
                Err(err("端口尚未监听"))
            };
            match response {
                Ok(()) => {
                    log(
                        &self.state_dir,
                        &format!(
                            "Health check passed after {} ms ({} probes: {} HTTP in {} ms; port listening at {} ms)",
                            started.elapsed().as_millis(),
                            probes,
                            http_probes,
                            http_probe_time.as_millis(),
                            listening_at.map(|at| at.as_millis()).unwrap_or(0)
                        ),
                    );
                    return Ok(ServerInfo {
                        url,
                        owned: true,
                        version: Some(spec.version.clone()),
                        label: Some(spec.label.clone()),
                        info: Some(info),
                    });
                }
                Err(error) => last_check = error.to_string(),
            }
            // Cheap gate -> poll tightly. Real requests -> a rejected or reset
            // connection means the server is up but busy, so back off briefly
            // instead of hammering it.
            let step = match (listening, started.elapsed().as_millis() < 1500) {
                (false, true) => 20,
                (true, _) => 100,
                (false, false) => 150,
            };
            sleep(step);
        }
        Err(err(format!(
            "等待 Pi Web 启动超时：{url}\n健康检查：{last_check}\n{}",
            self.output_tail
                .lock()
                .map(|v| v.clone())
                .unwrap_or_default()
        )))
    }

    fn cleanup_failed_start(&mut self, port: u16) -> Result<()> {
        // Share normal stop's verification and record-retention rules. Never
        // inspect a bare child_pid and treat a potentially reused PID as ours.
        self.stop(port, None)
    }

    fn pipe_output(
        &self,
        stdout: Option<impl std::io::Read + Send + 'static>,
        stderr: Option<impl std::io::Read + Send + 'static>,
    ) {
        // Two identical readers are spawned below through a helper, because the
        // concrete types of ChildStdout / ChildStderr differ.
        fn attach<R: std::io::Read + Send + 'static>(
            reader: Option<R>,
            tail: Arc<Mutex<String>>,
            state_dir: PathBuf,
        ) {
            let Some(reader) = reader else { return };
            std::thread::spawn(move || {
                let mut reader = BufReader::new(reader);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(b'\n', &mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    let text = String::from_utf8_lossy(&buffer).trim_end().to_string();
                    if text.is_empty() {
                        continue;
                    }
                    if let Ok(mut tail) = tail.lock() {
                        tail.push_str(&text);
                        tail.push('\n');
                        if tail.len() > 6000 {
                            let mut cut = tail.len() - 6000;
                            while cut > 0 && !tail.is_char_boundary(cut) {
                                cut += 1;
                            }
                            *tail = tail[cut..].to_string();
                        }
                    }
                    log(&state_dir, &format!("[pi-web] {text}"));
                }
            });
        }
        attach(stdout, self.output_tail.clone(), self.state_dir.clone());
        attach(stderr, self.output_tail.clone(), self.state_dir.clone());
    }
}

/// Cleanup diagnostics must never replace the actionable startup failure.
fn finish_start_attempt<T>(
    result: Result<T>,
    cleanup: impl FnOnce() -> Result<()>,
    report: impl FnOnce(&Error),
) -> Result<T> {
    if result.is_err() {
        if let Err(error) = cleanup() {
            report(&error);
        }
    }
    result
}

/// Side-effect seam: every stop attempt runs the safe handle fallback and
/// bounded completion check, even when termination fails. Neither failure nor
/// unknown completion permits deleting the ownership record or logging success.
fn cleanup_owned_process(
    terminate: impl FnOnce() -> Result<()>,
    fallback: impl FnOnce() -> Result<()>,
    verify: impl FnOnce() -> Result<()>,
    remove_record: impl FnOnce() -> Result<()>,
) -> Result<()> {
    let terminated = terminate();
    let fallback_result = fallback();
    let completed = verify();
    terminated.and(fallback_result).and(completed)?;
    remove_record()
}

/// `std::fs::canonicalize` returns verbatim `\\?\C:\...` paths on Windows,
/// whereas CIM's `ExecutablePath` is `C:\...`. Compare like with like.
fn normalize_windows_path(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy().into_owned();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Build the exact environment handed to the backend process.
fn server_environment(config: &Config) -> Result<HashMap<String, String>> {
    let source = std::env::vars_os()
        .filter_map(|(key, value)| Some((key.to_str()?.to_owned(), value.to_str()?.to_owned())))
        .collect();
    server_environment_from(config, &source)
}

/// Windows environment names are case-insensitive. Canonicalize only names we
/// manage so mixed-case variables cannot evade removals/overrides. Preserve
/// unknown names verbatim: Node workers and extensions may read them by case.
/// The source map seam keeps tests independent of the process environment.
fn server_environment_from(
    config: &Config,
    source: &HashMap<String, String>,
) -> Result<HashMap<String, String>> {
    let mut env = HashMap::new();
    let mut entries: Vec<_> = source.iter().collect();
    entries.sort_by_key(|(key, _)| *key);
    // Resolve impossible-on-Windows duplicate names deterministically in mocks:
    // canonical UPPERCASE, then lowercase, then the first mixed-case spelling.
    for (key, inherited) in entries {
        let canonical = key.to_ascii_uppercase();
        let managed = matches!(
            canonical.as_str(),
            "HTTP_PROXY"
                | "HTTPS_PROXY"
                | "ALL_PROXY"
                | "NO_PROXY"
                | "PI_LAUNCHER_PROXY_URL"
                | "PI_LAUNCHER_NO_PROXY"
                | "PI_LAUNCHER_NODE"
                | "PI_LAUNCHER_BACKEND_DIR"
                | "NODE_USE_ENV_PROXY"
                | "NODE_OPTIONS"
                | "PI_WEB_NO_OPEN"
                | "PI_WEB_APP_NAME"
                | "PI_WEB_SKIP_VERSION_CHECK"
                | "ELECTRON_RUN_AS_NODE"
                | "INIT_CWD"
                | "PATH"
                | "PROGRAMFILES"
        );
        if !managed {
            env.insert(key.clone(), inherited.clone());
            continue;
        }
        let value = source
            .get(&canonical)
            .or_else(|| source.get(&key.to_ascii_lowercase()))
            .unwrap_or(&source[key]);
        env.entry(canonical).or_insert_with(|| value.clone());
    }
    let explicit = env
        .get("PI_LAUNCHER_PROXY_URL")
        .cloned()
        .or_else(|| config.proxy_url.clone());
    let proxy = explicit
        .clone()
        .or_else(|| {
            ["HTTPS_PROXY", "HTTP_PROXY"]
                .iter()
                .find_map(|key| env.get(*key).cloned())
        })
        .unwrap_or_default();
    validate_proxy_url(Some(&proxy))?;
    for key in ["HTTP_PROXY", "HTTPS_PROXY"] {
        if proxy.is_empty() {
            env.remove(key);
        } else {
            env.insert(key.to_string(), proxy.clone());
        }
    }
    if explicit.as_deref() == Some("") {
        env.remove("ALL_PROXY");
    }
    let bypass = env.get("PI_LAUNCHER_NO_PROXY").cloned().unwrap_or_else(|| {
        let inherited = env.get("NO_PROXY").cloned().unwrap_or_default();
        format!("{},{}", config.no_proxy.join(","), inherited)
    });
    let mut items: Vec<String> = bypass
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(String::from)
        .collect();
    for local in ["localhost", "127.0.0.1", "::1"] {
        if !items.iter().any(|item| item == local) {
            items.push(local.to_string());
        }
    }
    let joined = items.join(",");
    env.insert("NO_PROXY".to_string(), joined);

    env.insert("NODE_USE_ENV_PROXY".to_string(), "1".to_string());
    env.insert("PI_WEB_NO_OPEN".to_string(), "1".to_string());
    env.insert("PI_WEB_APP_NAME".to_string(), "Pi Agent".to_string());
    env.insert("PI_WEB_SKIP_VERSION_CHECK".to_string(), "1".to_string());
    for key in [
        "ELECTRON_RUN_AS_NODE",
        "NODE_OPTIONS",
        "PI_LAUNCHER_BACKEND_DIR",
        "INIT_CWD",
    ] {
        env.remove(key);
    }
    env.retain(|key, _| {
        let lower = key.to_ascii_lowercase();
        !(lower.starts_with("npm_package_")
            || lower.starts_with("npm_lifecycle_")
            || matches!(
                lower.as_str(),
                "npm_command"
                    | "npm_execpath"
                    | "npm_node_execpath"
                    | "npm_config_package"
                    | "npm_config_local_prefix"
                    | "npm_config_offline"
            ))
    });
    if let Some(node) = &config.node_path {
        env.insert("PI_LAUNCHER_NODE".to_string(), node.clone());
    }
    Ok(env)
}

pub fn inspect_backend(root: &Path) -> Result<BackendSpec> {
    (|| -> Result<BackendSpec> {
        let package_file = fs::canonicalize(root.join("package.json"))?;
        let pkg: Value = serde_json::from_str(&fs::read_to_string(&package_file)?)?;
        if pkg.get("name").and_then(Value::as_str) != Some("@agegr/pi-web") {
            return Err(err("不是 Pi Web 后端目录"));
        }
        let version = pkg
            .get("version")
            .and_then(Value::as_str)
            .ok_or_else(|| err("package.json 缺少 version"))?
            .to_string();
        let entry = root.join("bin").join("pi-web.js");
        for file in [&entry, &root.join(".next").join("BUILD_ID")] {
            if !file.is_file() {
                return Err(err(format!("缺少文件 {}", file.display())));
            }
        }
        // Mirror Node's module lookup from the real backend package.
        for name in ["next", "@earendil-works/pi-coding-agent"] {
            let mut found = false;
            let mut cursor = Some(root);
            while let Some(directory) = cursor {
                let manifest = directory.join("node_modules").join(name).join("package.json");
                match fs::read_to_string(&manifest) {
                    Ok(text) => {
                        let dependency: Value = serde_json::from_str(&text)?;
                        if dependency.get("name").and_then(Value::as_str) != Some(name) {
                            return Err(err(format!("依赖 {name} 的 package.json 名称不匹配")));
                        }
                        found = true;
                        break;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error.into()),
                }
                cursor = directory.parent();
            }
            if !found {
                return Err(err(format!("后端模块搜索路径中缺少依赖 {name}")));
            }
        }
        // The label is cosmetic (log line and process record). source-release.json
        // is several megabytes of build manifest, and parsing it whole on every
        // launch cost more than the entire config read, so only a bounded prefix
        // is scanned for the two fields involved.
        let label = match read_release_label(&root.join("source-release.json"), &version) {
            Some(commit) => format!("{version} @ {commit}"),
            None => version.clone(),
        };
        Ok(BackendSpec {
            root: root.to_path_buf(),
            entry,
            version,
            label,
        })
    })()
    .map_err(|error| {
        Error(format!(
            "本地 Pi Web 后端不完整或无效：{}\n{}\n请检查 npm 安装目录或本地构建产物，并设置 PI_LAUNCHER_BACKEND_PATH / launcher-config.json 的 backendPath。启动器不会自动下载或修复。",
            root.display(),
            error
        ))
    })
}

/// Short commit shown next to the version, or `None` when the manifest has no
/// usable one. Only the head of the file is read: the fields sit in the first
/// few hundred bytes, and the rest is a build manifest large enough that plain
/// deserialization showed up in the startup timeline.
fn read_release_label(path: &Path, version: &str) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let mut buffer = vec![0u8; 8 * 1024];
    let read = file.read(&mut buffer).ok()?;
    let text = String::from_utf8_lossy(&buffer[..read]);
    let commit = json_string_field(&text, "commit")?;
    if commit.len() != 40 || !commit.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    if json_string_field(&text, "version").as_deref() != Some(version) {
        return None;
    }
    Some(commit[..12].to_string())
}

/// Value of a top-level `"key": "value"` pair in a partial JSON document.
fn json_string_field(text: &str, key: &str) -> Option<String> {
    let needle = format!("\"{key}\"");
    let mut cursor = 0;
    while let Some(offset) = text[cursor..].find(&needle) {
        let start = cursor + offset + needle.len();
        cursor = start;
        let rest = text[start..].trim_start();
        let Some(rest) = rest.strip_prefix(':') else {
            continue;
        };
        let rest = rest.trim_start();
        let Some(rest) = rest.strip_prefix('"') else {
            continue;
        };
        if let Some(end) = rest.find('"') {
            return Some(rest[..end].to_string());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    const COMMIT: &str = "0123456789abcdef0123456789abcdef01234567";

    fn config() -> Config {
        serde_json::from_str(include_str!("../../config/launcher-defaults.json")).unwrap()
    }

    fn source(entries: &[(&str, &str)]) -> HashMap<String, String> {
        entries
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect()
    }

    #[test]
    fn cleanup_failures_keep_record_and_still_run_safe_fallback_and_verification() {
        use std::cell::Cell;
        for failed_step in ["terminate", "fallback", "verify"] {
            let fallback_ran = Cell::new(false);
            let verified = Cell::new(false);
            let removed = Cell::new(false);
            let result = cleanup_owned_process(
                || {
                    if failed_step == "terminate" {
                        Err(err("termination denied"))
                    } else {
                        Ok(())
                    }
                },
                || {
                    fallback_ran.set(true);
                    if failed_step == "fallback" {
                        Err(err("child alive"))
                    } else {
                        Ok(())
                    }
                },
                || {
                    verified.set(true);
                    if failed_step == "verify" {
                        Err(err("still alive or unknown"))
                    } else {
                        Ok(())
                    }
                },
                || {
                    removed.set(true);
                    Ok(())
                },
            );
            assert!(result.is_err(), "{failed_step}");
            assert!(fallback_ran.get());
            assert!(verified.get());
            assert!(
                !removed.get(),
                "must retain record after {failed_step} failure"
            );
        }
    }

    #[test]
    fn cleanup_removes_record_only_after_confirmed_completion() {
        use std::cell::RefCell;
        let calls = RefCell::new(Vec::new());
        cleanup_owned_process(
            || {
                calls.borrow_mut().push("terminate");
                Ok(())
            },
            || {
                calls.borrow_mut().push("fallback");
                Ok(())
            },
            || {
                calls.borrow_mut().push("verify");
                Ok(())
            },
            || {
                calls.borrow_mut().push("remove");
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(
            *calls.borrow(),
            ["terminate", "fallback", "verify", "remove"]
        );
        assert!(cleanup_owned_process(
            || Ok(()),
            || Ok(()),
            || Ok(()),
            || Err(err("remove denied"))
        )
        .is_err());
    }

    #[test]
    fn failed_start_preserves_original_error_even_when_cleanup_fails() {
        let result: Result<()> = finish_start_attempt(
            Err(err("original startup failure")),
            || Err(err("cleanup failure")),
            |error| assert_eq!(error.to_string(), "cleanup failure"),
        );
        assert_eq!(result.unwrap_err().to_string(), "original startup failure");
        assert_eq!(
            finish_start_attempt(Ok(42), || panic!("no cleanup on success"), |_| panic!()).unwrap(),
            42
        );
    }

    #[test]
    fn environment_strips_mixed_case_specials_and_overrides_flags() {
        let inherited = source(&[
            ("Node_Options", "--inspect"),
            ("Electron_Run_As_Node", "1"),
            ("Pi_Launcher_Backend_Dir", "stale"),
            ("Init_Cwd", "stale"),
            ("Npm_Package_Name", "parent"),
            ("nPm_Lifecycle_event", "dev"),
            ("Npm_Config_Offline", "true"),
            ("Npm_Execpath", "npm"),
            ("node_use_env_proxy", "0"),
            ("pi_web_no_open", "0"),
            ("pi_web_app_name", "other"),
            ("pi_web_skip_version_check", "0"),
            ("pAtH", "C:\\node"),
            ("ProgramFiles", "C:\\Programs"),
        ]);
        let env = server_environment_from(&config(), &inherited).unwrap();
        for key in [
            "NODE_OPTIONS",
            "ELECTRON_RUN_AS_NODE",
            "PI_LAUNCHER_BACKEND_DIR",
            "INIT_CWD",
            "NPM_PACKAGE_NAME",
            "NPM_LIFECYCLE_EVENT",
            "NPM_CONFIG_OFFLINE",
            "NPM_EXECPATH",
        ] {
            assert!(!env.contains_key(key), "{key}");
        }
        assert_eq!(env["NODE_USE_ENV_PROXY"], "1");
        assert_eq!(env["PI_WEB_NO_OPEN"], "1");
        assert_eq!(env["PI_WEB_APP_NAME"], "Pi Agent");
        assert_eq!(env["PI_WEB_SKIP_VERSION_CHECK"], "1");
        assert_eq!(env["PATH"], "C:\\node");
        assert_eq!(env["PROGRAMFILES"], "C:\\Programs");
        assert!(!env.contains_key("pAtH"));
        assert!(!env.contains_key("node_use_env_proxy"));
    }

    #[test]
    fn environment_preserves_unmanaged_key_spelling_for_node_workers() {
        let inherited = source(&[
            ("CustomMixedCase", "extension setting"),
            ("npm_config_customSetting", "custom npm setting"),
            ("SystemRoot", "C:\\Windows"),
        ]);
        let env = server_environment_from(&config(), &inherited).unwrap();
        for (key, value) in inherited {
            assert_eq!(env.get(&key), Some(&value));
            assert!(!env.contains_key(&key.to_ascii_uppercase()));
        }
    }

    #[test]
    fn environment_inherits_https_first_without_promoting_all_proxy() {
        let inherited = source(&[
            ("hTtPs_PrOxY", "http://secure.example:8080"),
            ("Http_Proxy", "http://other.example:8080"),
            ("All_Proxy", "socks5://other.example:1080"),
        ]);
        let env = server_environment_from(&config(), &inherited).unwrap();
        assert_eq!(env["HTTP_PROXY"], "http://secure.example:8080");
        assert_eq!(env["HTTPS_PROXY"], env["HTTP_PROXY"]);
        assert_eq!(env["ALL_PROXY"], "socks5://other.example:1080");
        let env = server_environment_from(
            &config(),
            &source(&[("aLl_PrOxY", "socks5://other.example:1080")]),
        )
        .unwrap();
        assert!(!env.contains_key("HTTP_PROXY"));
        assert!(!env.contains_key("HTTPS_PROXY"));
        assert!(env.contains_key("ALL_PROXY"));
    }

    #[test]
    fn environment_explicit_disable_removes_every_proxy_casing() {
        let inherited = source(&[
            ("Http_Proxy", "http://old.example"),
            ("hTtPs_PrOxY", "http://old.example"),
            ("All_Proxy", "socks5://old.example"),
        ]);
        let mut cfg = config();
        cfg.proxy_url = Some(String::new());
        let env = server_environment_from(&cfg, &inherited).unwrap();
        assert!(env
            .keys()
            .all(|key| !matches!(key.as_str(), "HTTP_PROXY" | "HTTPS_PROXY" | "ALL_PROXY")));
        let mut inherited = inherited;
        inherited.insert("Pi_Launcher_Proxy_Url".into(), "".into());
        cfg.proxy_url = Some("http://configured.example".into());
        let env = server_environment_from(&cfg, &inherited).unwrap();
        assert!(!env.contains_key("ALL_PROXY"));
        assert!(!env.contains_key("HTTP_PROXY"));
    }

    #[test]
    fn environment_proxy_override_and_no_proxy_semantics() {
        let mut cfg = config();
        cfg.proxy_url = Some("http://configured.example".into());
        cfg.no_proxy = vec!["configured.example".into()];
        let inherited = source(&[
            ("No_Proxy", "inherited.example,localhost"),
            ("pi_launcher_proxy_url", "http://override.example"),
        ]);
        let env = server_environment_from(&cfg, &inherited).unwrap();
        assert_eq!(env["HTTPS_PROXY"], "http://override.example");
        assert_eq!(
            env["NO_PROXY"],
            "configured.example,inherited.example,localhost,127.0.0.1,::1"
        );
        let mut inherited = inherited;
        inherited.insert(
            "Pi_Launcher_No_Proxy".into(),
            " explicit.example ,localhost".into(),
        );
        let env = server_environment_from(&cfg, &inherited).unwrap();
        assert_eq!(env["NO_PROXY"], "explicit.example,localhost,127.0.0.1,::1");
        assert!(server_environment_from(&cfg, &source(&[("hTtPs_PrOxY", "invalid")])).is_ok()); // explicit config wins
        cfg.proxy_url = None;
        assert!(server_environment_from(&cfg, &source(&[("hTtPs_PrOxY", "invalid")])).is_err());
    }

    #[test]
    fn environment_duplicate_casings_resolve_deterministically() {
        let env = server_environment_from(
            &config(),
            &source(&[
                ("HTTPS_PROXY", "http://upper.example"),
                ("https_proxy", "http://lower.example"),
                ("Https_Proxy", "http://mixed.example"),
            ]),
        )
        .unwrap();
        assert_eq!(env["HTTPS_PROXY"], "http://upper.example");
        assert_eq!(
            env.keys()
                .filter(|key| key.eq_ignore_ascii_case("https_proxy"))
                .count(),
            1
        );
    }

    /// Opt-in integration fixture: built-in Node HTTP only, fake package
    /// manifests, disposable state/home/cwd, sanitized environment, random port.
    /// Run explicitly with `cargo test lifecycle_fixture -- --ignored --test-threads=1`.
    struct LifecycleFixture {
        backend: PiBackend,
        root: PathBuf,
        external: Option<Child>,
    }

    impl LifecycleFixture {
        fn new(hang: bool) -> Self {
            let node = std::env::var_os("PI_LAUNCHER_TEST_NODE")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::split_paths(&std::env::var_os("PATH")?)
                        .map(|directory| directory.join("node.exe"))
                        .find(|candidate| candidate.is_file())
                })
                .expect("fixture needs node.exe on PATH or PI_LAUNCHER_TEST_NODE");
            let node = normalize_windows_path(fs::canonicalize(node).unwrap());
            let root = std::env::temp_dir().join(format!(
                "pi-launcher-lifecycle-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            for directory in [
                "state",
                "home",
                "temp",
                "backend/bin",
                "backend/.next",
                "backend/node_modules/next",
                "backend/node_modules/@earendil-works/pi-coding-agent",
            ] {
                fs::create_dir_all(root.join(directory)).unwrap();
            }
            for (directory, name) in [
                ("backend", "@agegr/pi-web"),
                ("backend/node_modules/next", "next"),
                (
                    "backend/node_modules/@earendil-works/pi-coding-agent",
                    "@earendil-works/pi-coding-agent",
                ),
            ] {
                fs::write(
                    root.join(directory).join("package.json"),
                    serde_json::json!({"name": name, "version": "0.0.0-fixture"}).to_string(),
                )
                .unwrap();
            }
            fs::write(root.join("backend/.next/BUILD_ID"), "fixture").unwrap();
            fs::write(root.join("backend/bin/pi-web.js"), r#"
const http = require('node:http');
const port = Number(process.argv[process.argv.indexOf('--port') + 1]);
http.createServer((req, res) => {
  if (process.env.PI_FIXTURE_HANG === '1') return;
  const body = JSON.stringify(req.url === '/manifest.webmanifest' ? {name: 'Pi Web'} : {home: process.cwd()});
  res.writeHead(200, {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body)});
  res.end(body);
}).listen(port, '127.0.0.1');
"#).unwrap();
            let listener = std::net::TcpListener::bind((HOST, 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let mut config = config();
            config.port = port as i64;
            config.backend_path = Some(root.join("backend").to_string_lossy().into_owned());
            config.cwd = Some(root.join("home").to_string_lossy().into_owned());
            config.node_path = Some(node.to_string_lossy().into_owned());
            config.proxy_url = Some(String::new());
            config.startup_timeout_ms = 5000;
            let mut source = HashMap::new();
            source.insert(
                "SystemRoot".into(),
                std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".into()),
            );
            source.insert(
                "TEMP".into(),
                root.join("temp").to_string_lossy().into_owned(),
            );
            for name in ["USERPROFILE", "HOME", "APPDATA", "LOCALAPPDATA"] {
                source.insert(
                    name.into(),
                    root.join("home").to_string_lossy().into_owned(),
                );
            }
            source.insert(
                "PI_FIXTURE_HANG".into(),
                if hang { "1" } else { "0" }.into(),
            );
            let env = server_environment_from(&config, &source).unwrap();
            // Query with the same credential-free environment, then seed only
            // this fixture's runtime cache to avoid inheriting NODE_OPTIONS.
            let mut version_command = crate::process::hidden_command(&node);
            version_command.arg("--version").env_clear().envs(&env);
            let version =
                crate::process::output_within(version_command, std::time::Duration::from_secs(5))
                    .unwrap();
            assert!(version.status.success());
            let metadata = fs::metadata(&node).unwrap();
            fs::write(root.join("state/node-runtime.json"), serde_json::json!({
                "path": node.to_string_lossy(), "length": metadata.len(),
                "modified": metadata.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs(),
                "version": String::from_utf8_lossy(&version.stdout).trim(),
            }).to_string()).unwrap();
            Self {
                backend: PiBackend {
                    state_dir: root.join("state"),
                    config,
                    node: None,
                    env,
                    closed: Arc::new(AtomicBool::new(false)),
                    child: Arc::new(Mutex::new(None)),
                    child_pid: None,
                    child_info: None,
                    job: None,
                    output_tail: Arc::new(Mutex::new(String::new())),
                },
                root,
                external: None,
            }
        }

        fn spawn_external(&mut self) {
            let mut command =
                crate::process::hidden_command(self.backend.config.node_path.as_ref().unwrap());
            command
                .arg(self.root.join("backend/bin/pi-web.js"))
                .args(["--port", &self.backend.port().to_string()])
                .current_dir(self.root.join("home"))
                .env_clear()
                .envs(&self.backend.env)
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            self.external = Some(command.spawn().unwrap());
            let started = Instant::now();
            let url = format!("http://{HOST}:{}", self.backend.port());
            while !check_server(&url, &self.backend.closed) {
                assert!(
                    started.elapsed() < std::time::Duration::from_secs(5),
                    "fixture did not listen"
                );
                sleep(20);
            }
        }
    }

    impl Drop for LifecycleFixture {
        fn drop(&mut self) {
            let _ = self.backend.stop(self.backend.port(), None);
            // Close only our own job, even if a test assertion/stop failed.
            self.backend.job.take();
            if let Some(child) = self.external.as_mut() {
                let _ = child.kill();
                let _ = wait_for_completion(|| Ok(child.try_wait()?.is_some()));
            }
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    #[ignore = "isolated Windows Node >=22.19 lifecycle fixture; explicit opt-in"]
    fn lifecycle_fixture_owned_start_stop_releases_port() {
        let mut fixture = LifecycleFixture::new(false);
        let port = fixture.backend.port();
        let server = fixture.backend.start(port).unwrap();
        assert!(server.owned);
        assert!(!is_port_free(port));
        assert!(fixture.backend.record_path(port).is_file());
        fixture.backend.stop(port, server.info.as_ref()).unwrap();
        assert!(fixture
            .backend
            .wait_for_port_free(port, std::time::Duration::from_millis(1500)));
        assert!(fixture.backend.child_has_exited().unwrap());
        assert!(!fixture.backend.record_path(port).exists());
    }

    #[test]
    #[ignore = "isolated Windows Node HTTP fixture; explicit opt-in"]
    fn lifecycle_fixture_external_reuse_does_not_kill_service() {
        let mut fixture = LifecycleFixture::new(false);
        fixture.spawn_external();
        let port = fixture.backend.port();
        let server = fixture.backend.start(port).unwrap();
        assert!(!server.owned);
        assert!(!fixture.backend.spawned());
        fixture.backend.stop(port, server.info.as_ref()).unwrap();
        assert!(fixture
            .external
            .as_mut()
            .unwrap()
            .try_wait()
            .unwrap()
            .is_none());
        assert!(check_server(&server.url, &fixture.backend.closed));
    }

    #[test]
    #[ignore = "isolated Windows Node >=22.19 cancellation fixture; explicit opt-in"]
    fn lifecycle_fixture_cancel_start_cleans_up_child() {
        let mut fixture = LifecycleFixture::new(true);
        let port = fixture.backend.port();
        let record = fixture.backend.record_path(port);
        let closed = fixture.backend.closed.clone();
        let cancel = std::thread::spawn(move || {
            let started = Instant::now();
            while (!record.exists() || is_port_free(port))
                && started.elapsed() < std::time::Duration::from_secs(3)
            {
                sleep(10);
            }
            closed.store(true, Ordering::SeqCst);
        });
        let result = fixture.backend.start(port);
        cancel.join().unwrap();
        assert!(result.is_err());
        assert!(
            fixture.backend.child_pid.is_some(),
            "cancel only after spawn"
        );
        assert!(fixture.backend.child_has_exited().unwrap());
        assert!(fixture
            .backend
            .job
            .as_ref()
            .map(|job| job.is_empty().unwrap())
            .unwrap_or(true));
        assert!(fixture
            .backend
            .wait_for_port_free(port, std::time::Duration::from_millis(1500)));
        assert!(!fixture.backend.record_path(port).exists());
    }

    fn temp_manifest(name: &str, contents: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pi-launcher-test-{}-{name}.json",
            std::process::id()
        ));
        fs::write(&path, contents).expect("write manifest");
        path
    }

    #[test]
    fn reads_string_fields_from_partial_json() {
        let text = r#"{"version":"0.1.0","commit":"abc","nested":{"commit":"zzz"}}"#;
        assert_eq!(json_string_field(text, "version").as_deref(), Some("0.1.0"));
        assert_eq!(json_string_field(text, "commit").as_deref(), Some("abc"));
        assert_eq!(json_string_field(text, "missing"), None);
        // A non-string value must not be reported as a string.
        assert_eq!(json_string_field(r#"{"commit":42}"#, "commit"), None);
    }

    #[test]
    fn release_label_uses_short_commit() {
        let path = temp_manifest(
            "label-ok",
            &format!(r#"{{"version":"0.1.0","commit":"{COMMIT}","files":[]}}"#),
        );
        assert_eq!(
            read_release_label(&path, "0.1.0").as_deref(),
            Some(&COMMIT[..12])
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn release_label_requires_matching_version_and_full_commit() {
        let wrong_version = temp_manifest(
            "label-version",
            &format!(r#"{{"version":"9.9.9","commit":"{COMMIT}"}}"#),
        );
        assert_eq!(read_release_label(&wrong_version, "0.1.0"), None);
        let _ = fs::remove_file(&wrong_version);

        let short = temp_manifest("label-short", r#"{"version":"0.1.0","commit":"abc123"}"#);
        assert_eq!(read_release_label(&short, "0.1.0"), None);
        let _ = fs::remove_file(&short);

        let missing = temp_manifest("label-missing", r#"{"version":"0.1.0"}"#);
        assert_eq!(read_release_label(&missing, "0.1.0"), None);
        let _ = fs::remove_file(&missing);
    }

    #[test]
    fn release_label_tolerates_an_absent_manifest() {
        let path = std::env::temp_dir().join("pi-launcher-test-does-not-exist.json");
        assert_eq!(read_release_label(&path, "0.1.0"), None);
    }
}
