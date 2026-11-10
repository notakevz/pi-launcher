use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use crate::util::{err, is_absolute_path, Result};

const DEFAULTS: &str = include_str!("../../config/launcher-defaults.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(rename = "schemaVersion")]
    pub schema_version: i64,
    #[serde(rename = "backendPath", default)]
    pub backend_path: Option<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    pub port: i64,
    #[serde(rename = "nodePath", default)]
    pub node_path: Option<String>,
    #[serde(rename = "proxyUrl", default)]
    pub proxy_url: Option<String>,
    #[serde(rename = "noProxy", default)]
    pub no_proxy: Vec<String>,
    #[serde(rename = "startupTimeoutMs")]
    pub startup_timeout_ms: i64,
}

impl Config {
    pub fn port_u16(&self) -> u16 {
        self.port as u16
    }
}

/// Defaults -> user JSON -> `PI_LAUNCHER_*` overrides, then full validation.
pub fn read_config(state_dir: &Path) -> Result<Config> {
    let defaults: Value =
        serde_json::from_str(DEFAULTS).map_err(|_| err("内置的 launcher-defaults.json 无效。"))?;

    let file = state_dir.join("launcher-config.json");
    let user: Value = match std::fs::read_to_string(&file) {
        Ok(text) => {
            // Notepad, PowerShell 5.1's `Set-Content -Encoding utf8` and many
            // editors prepend a UTF-8 BOM. JSON forbids it, and rejecting the
            // file for an invisible byte is a terrible first-run experience.
            let text = text.trim_start_matches('\u{feff}');
            serde_json::from_str(text).map_err(|_| {
                // Never echo parse details: the input may contain credentials.
                err("无法读取 launcher-config.json：请检查文件权限和 JSON 格式。")
            })?
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(error) => return Err(error.into()),
    };
    let user = user
        .as_object()
        .ok_or_else(|| err("launcher-config.json 必须是 JSON 对象。"))?;

    let mut merged: Map<String, Value> = defaults
        .as_object()
        .cloned()
        .ok_or_else(|| err("内置的 launcher-defaults.json 必须是 JSON 对象。"))?;
    for (key, value) in user {
        merged.insert(key.clone(), value.clone());
    }
    apply_env_overrides(&mut merged);

    let mut config = deserialize_config(merged)?;
    config.validate()?;
    Ok(config)
}

fn deserialize_config(merged: Map<String, Value>) -> Result<Config> {
    // Serde's type errors can include the rejected string verbatim. A misplaced
    // proxy URL or credential must not escape into a log or message box.
    serde_json::from_value(Value::Object(merged)).map_err(|_| {
        err("launcher-config.json 字段类型无效：请按配置指南检查各字段的类型，不要将整数写为字符串。")
    })
}

fn apply_env_overrides(merged: &mut Map<String, Value>) {
    let text_fields = [
        ("PI_LAUNCHER_BACKEND_PATH", "backendPath"),
        ("PI_LAUNCHER_CWD", "cwd"),
        ("PI_LAUNCHER_NODE", "nodePath"),
        ("PI_LAUNCHER_PROXY_URL", "proxyUrl"),
    ];
    for (variable, key) in text_fields {
        if let Some(value) = std::env::var_os(variable) {
            merged.insert(key.to_string(), json!(value.to_string_lossy()));
        }
    }
    if let Some(value) = std::env::var_os("PI_LAUNCHER_NO_PROXY") {
        let list: Vec<String> = value
            .to_string_lossy()
            .split(',')
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(String::from)
            .collect();
        merged.insert("noProxy".to_string(), json!(list));
    }
    for (variable, key) in [
        ("PI_LAUNCHER_PORT", "port"),
        ("PI_LAUNCHER_STARTUP_TIMEOUT_MS", "startupTimeoutMs"),
    ] {
        if let Some(value) = std::env::var_os(variable) {
            // An empty value becomes -1 so the range check reports a clear error.
            let raw = value.to_string_lossy();
            let number = raw.trim().parse::<i64>().unwrap_or(-1);
            merged.insert(key.to_string(), json!(number));
        }
    }
}

impl Config {
    fn validate(&mut self) -> Result<()> {
        if self.schema_version != 1 {
            return Err(err("launcher-config.json schemaVersion 必须为 1。"));
        }
        if self.cwd.is_none() {
            let home = std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .ok_or_else(|| err("找不到用户主目录，请显式配置 cwd。"))?;
            self.cwd = Some(home.to_string_lossy().into_owned());
        }
        for (name, value) in [
            ("backendPath", self.backend_path.as_deref()),
            ("cwd", self.cwd.as_deref()),
            ("nodePath", self.node_path.as_deref()),
        ] {
            if let Some(value) = value {
                check_path(name, value)?;
            }
        }
        if !Path::new(self.cwd.as_deref().unwrap_or_default()).is_dir() {
            return Err(err(format!(
                "工作目录 cwd 不存在：{}",
                self.cwd.as_deref().unwrap_or_default()
            )));
        }
        if let Some(node) = self.node_path.as_deref() {
            if !Path::new(node).is_file() {
                return Err(err(format!(
                    "nodePath / PI_LAUNCHER_NODE 不存在或不是文件：{node}"
                )));
            }
        }
        if !(1..=65535).contains(&self.port) {
            return Err(err("port / PI_LAUNCHER_PORT 必须是 1–65535 的整数。"));
        }
        if !(1..=2_147_483_647).contains(&self.startup_timeout_ms) {
            return Err(err("startupTimeoutMs 必须是 1–2147483647 的整数毫秒。"));
        }
        validate_proxy_url(self.proxy_url.as_deref())?;
        if self
            .no_proxy
            .iter()
            .any(|value| value.chars().any(|c| matches!(c, '\r' | '\n' | ',')))
        {
            return Err(err("noProxy 必须是字符串数组，每项为单个地址或域名。"));
        }
        Ok(())
    }
}

fn check_path(name: &str, value: &str) -> Result<()> {
    if value.is_empty()
        || value.trim().is_empty()
        || !is_absolute_path(value)
        || value.contains('\0')
    {
        return Err(err(format!("{name} 必须是绝对路径（可选路径可为 null）。")));
    }
    Ok(())
}

/// `None` inherits the environment proxy, `Some("")` explicitly disables it.
pub fn validate_proxy_url(value: Option<&str>) -> Result<()> {
    let value = match value {
        None | Some("") => return Ok(()),
        Some(value) => value,
    };
    if value.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err(err(proxy_error()));
    }
    let (_, authority) = value.split_once("://").ok_or_else(|| err(proxy_error()))?;
    let authority = authority.strip_suffix('/').unwrap_or(authority);
    if authority.is_empty() || authority.contains(['/', '\\', '?', '#']) {
        return Err(err(proxy_error()));
    }
    let parsed = tauri::Url::parse(value).map_err(|_| err(proxy_error()))?;
    if !matches!(parsed.scheme(), "http" | "https")
        || parsed.host_str().is_none_or(str::is_empty)
        || parsed.path() != "/"
        || parsed.query().is_some()
        || parsed.fragment().is_some()
    {
        return Err(err(proxy_error()));
    }
    Ok(())
}

fn proxy_error() -> &'static str {
    "proxyUrl / 代理环境变量必须是有效的 HTTP(S) 代理 URL（或空字符串禁用）。"
}

pub fn require_backend_path(root: Option<&str>) -> Result<&str> {
    match root {
        Some(value) if !value.is_empty() => Ok(value),
        _ => Err(err(
            "未配置 backendPath。请将 launcher-config.json 的 backendPath 或 PI_LAUNCHER_BACKEND_PATH 设置为 Pi Web 的 npm 安装目录或本地构建产物目录。启动器不会自动下载。",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn proxy_url_accepts_http_and_https() {
        assert!(validate_proxy_url(None).is_ok());
        // Empty string is the explicit "do not use a proxy" value.
        assert!(validate_proxy_url(Some("")).is_ok());
        assert!(validate_proxy_url(Some("http://127.0.0.1:10808")).is_ok());
        assert!(validate_proxy_url(Some("https://proxy.example:8443")).is_ok());
        assert!(validate_proxy_url(Some("http://proxy.example:8080/")).is_ok());
        // Credentials are allowed; the launcher never logs the value.
        assert!(validate_proxy_url(Some("http://user:pass@proxy:8080")).is_ok());
    }

    #[test]
    fn proxy_url_rejects_unsupported_shapes() {
        assert!(validate_proxy_url(Some("socks5://127.0.0.1:1080")).is_err());
        assert!(validate_proxy_url(Some("http://")).is_err());
        assert!(validate_proxy_url(Some("http://proxy:8080/path")).is_err());
        assert!(validate_proxy_url(Some("http://proxy?x=1")).is_err());
        assert!(validate_proxy_url(Some("127.0.0.1:10808")).is_err());
        assert!(validate_proxy_url(Some("http://@")).is_err());
        for value in [
            "http://:8080",
            "http://proxy:99999",
            "http://proxy:not-a-port",
            "http://proxy:80\n",
            "http://proxy name:80",
            "http://proxy/#secret",
            "http:proxy",
            "http:///proxy",
            r"http://proxy\path",
        ] {
            assert!(
                validate_proxy_url(Some(value)).is_err(),
                "accepted invalid proxy"
            );
        }
    }

    #[test]
    fn type_errors_never_echo_credentials() {
        for field in ["port", "startupTimeoutMs", "noProxy", "schemaVersion"] {
            let mut merged: Map<String, Value> = serde_json::from_str(DEFAULTS).unwrap();
            merged.insert(
                field.into(),
                json!("http://test-user:TEST_SECRET@proxy:8080"),
            );
            let message = deserialize_config(merged).unwrap_err().to_string();
            assert!(!message.contains("TEST_SECRET"));
            assert!(!message.contains("test-user"));
            assert!(message.contains("字段类型无效"));
        }
    }

    #[test]
    fn path_fields_must_be_absolute() {
        assert!(check_path("backendPath", r"C:\pi\backend").is_ok());
        assert!(check_path("backendPath", r"\\server\share\pi").is_ok());
        assert!(check_path("backendPath", "backend").is_err());
        assert!(check_path("backendPath", "").is_err());
        assert!(check_path("backendPath", "   ").is_err());
        // A NUL byte cannot be part of a path handed to Win32.
        let mut with_nul = String::from(r"C:\pi");
        with_nul.push('\u{0}');
        with_nul.push('x');
        assert!(check_path("backendPath", &with_nul).is_err());
    }

    #[test]
    fn accepts_a_config_saved_with_a_utf8_bom() {
        let dir = std::env::temp_dir().join(format!("pi-launcher-bom-{}", std::process::id()));
        fs::create_dir_all(&dir).expect("create temp dir");
        let mut text = String::from("\u{feff}"); // BOM, as Notepad writes it
        text.push_str(r#"{"schemaVersion":1,"port":30152}"#);
        fs::write(dir.join("launcher-config.json"), text).expect("write config");

        let config = read_config(&dir).expect("a BOM must not make the config unreadable");
        assert_eq!(config.port, 30152);
        let _ = fs::remove_dir_all(&dir);
    }
}
