//! Bounded, cancellable HTTP probes over a direct IPv4 loopback socket.
//! A single deadline covers connecting, writing, headers and body. Socket
//! timeouts are only short polling intervals, not a replacement for that deadline.

use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use serde_json::Value;

use crate::util::{err, Error, Result, HOST};

const CONNECT_TIMEOUT: Duration = Duration::from_millis(150);
const READ_TIMEOUT: Duration = Duration::from_secs(2);
const CANCEL_POLL: Duration = Duration::from_millis(100);
const MAX_BODY: usize = 100_000;
const MAX_LINE: usize = 8 * 1024;
const MAX_HEADERS: usize = 32 * 1024;

/// Next.js may spend seconds loading its route graph on the first request.
/// This budget must also fit within the remaining overall startup timeout.
pub const FIRST_REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

pub fn check_server(base: &str, closed: &AtomicBool) -> bool {
    check_server_detail(base, closed).is_ok()
}

fn check_server_detail(base: &str, closed: &AtomicBool) -> Result<()> {
    let manifest = local_json_within(
        &format!("{base}/manifest.webmanifest"),
        READ_TIMEOUT,
        closed,
    )?;
    if !matches!(
        manifest.get("name").and_then(Value::as_str),
        Some("Pi Web") | Some("Pi Agent")
    ) {
        return Err(err("manifest.webmanifest 的 name 不是 Pi Web / Pi Agent"));
    }
    check_ready_within(base, READ_TIMEOUT, closed)
}

/// For our own verified child only `/api/home` is needed as the readiness gate.
pub fn check_ready_within(base: &str, timeout: Duration, closed: &AtomicBool) -> Result<()> {
    let home = local_json_within(&format!("{base}/api/home"), timeout, closed)?;
    if home
        .get("home")
        .and_then(Value::as_str)
        .map(is_windows_absolute)
        .unwrap_or(false)
    {
        Ok(())
    } else {
        Err(err("api/home 的 home 不是 Windows 绝对路径"))
    }
}

fn is_windows_absolute(value: &str) -> bool {
    if value.starts_with(r"\\") {
        return value.len() > 2;
    }
    let mut chars = value.chars();
    matches!(
        (chars.next(), chars.next(), chars.next()),
        (Some(drive), Some(':'), Some(sep))
            if drive.is_ascii_alphabetic() && (sep == '\\' || sep == '/')
    )
}

pub fn is_port_free(port: u16) -> bool {
    TcpListener::bind((HOST, port)).is_ok()
}

struct Budget<'a> {
    deadline: Instant,
    closed: &'a AtomicBool,
}

impl Budget<'_> {
    fn remaining(&self) -> io::Result<Duration> {
        if self.closed.load(Ordering::SeqCst) {
            // read_exact/read_to_end automatically retry Interrupted, so cancellation
            // must use a terminal error kind rather than an interrupted syscall.
            return Err(io::Error::new(
                io::ErrorKind::ConnectionAborted,
                "应用正在退出",
            ));
        }
        self.deadline
            .checked_duration_since(Instant::now())
            .filter(|left| !left.is_zero())
            .ok_or_else(|| io::Error::new(io::ErrorKind::TimedOut, "本地 HTTP 请求超时"))
    }
}

struct DeadlineStream<'a> {
    socket: TcpStream,
    budget: Budget<'a>,
}

impl Read for DeadlineStream<'_> {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        loop {
            let left = self.budget.remaining()?;
            self.socket.set_read_timeout(Some(left.min(CANCEL_POLL)))?;
            match self.socket.read(buffer) {
                Err(error) if retryable(&error) => continue,
                result => {
                    self.budget.remaining()?;
                    return result;
                }
            }
        }
    }
}

impl Write for DeadlineStream<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        loop {
            let left = self.budget.remaining()?;
            self.socket.set_write_timeout(Some(left.min(CANCEL_POLL)))?;
            match self.socket.write(buffer) {
                Err(error) if retryable(&error) => continue,
                result => {
                    self.budget.remaining()?;
                    return result;
                }
            }
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        self.budget.remaining()?;
        self.socket.flush()
    }
}

fn retryable(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted
    )
}

fn read_line(reader: &mut impl BufRead) -> Result<String> {
    let mut bytes = Vec::new();
    (&mut *reader)
        .take((MAX_LINE + 1) as u64)
        .read_until(b'\n', &mut bytes)?;
    if bytes.len() > MAX_LINE {
        return Err(err("HTTP line too large"));
    }
    if !bytes.ends_with(b"\r\n") {
        return Err(err("HTTP line is truncated or has invalid framing"));
    }
    String::from_utf8(bytes).map_err(|_| err("HTTP header is not UTF-8"))
}

fn count_headers(total: &mut usize, length: usize) -> Result<()> {
    if length > MAX_HEADERS.saturating_sub(*total) {
        return Err(err("HTTP headers too large"));
    }
    *total += length;
    Ok(())
}

fn local_json_within(url: &str, timeout: Duration, closed: &AtomicBool) -> Result<Value> {
    // Never accept hostnames, non-loopback IPs or request-line control bytes.
    let rest = url
        .strip_prefix("http://127.0.0.1:")
        .ok_or_else(|| err("非法的本地 HTTP 地址"))?;
    let (port, path) = rest.split_once('/').unwrap_or((rest, ""));
    let port: u16 = port.parse().map_err(|_| err("非法的本地 HTTP 端口"))?;
    if path.bytes().any(|byte| byte <= b' ' || byte == 0x7f) {
        return Err(err("非法的本地 HTTP 路径"));
    }
    let budget = Budget {
        deadline: Instant::now()
            .checked_add(timeout)
            .ok_or_else(|| err("非法的本地 HTTP 超时"))?,
        closed,
    };
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let socket = TcpStream::connect_timeout(&address, budget.remaining()?.min(CONNECT_TIMEOUT))?;
    let mut stream = DeadlineStream { socket, budget };
    let request = format!(
        "GET /{path} HTTP/1.1\r\nHost: {HOST}:{port}\r\nAccept: application/json\r\nConnection: close\r\n\r\n"
    );
    stream.write_all(request.as_bytes())?;
    let mut reader = BufReader::new(stream);
    let status_line = read_line(&mut reader)?;
    let mut parts = status_line.split_whitespace();
    if !matches!(parts.next(), Some("HTTP/1.0") | Some("HTTP/1.1")) {
        return Err(err("本地服务返回了无效的 HTTP 状态行"));
    }
    let status = parts
        .next()
        .and_then(|code| code.parse::<u16>().ok())
        .ok_or_else(|| err("本地服务返回了无效的 HTTP 状态码"))?;
    let mut header_bytes = status_line.len();
    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    loop {
        let line = read_line(&mut reader)?;
        count_headers(&mut header_bytes, line.len())?;
        if line == "\r\n" {
            break;
        }
        let (key, value) = line
            .split_once(':')
            .ok_or_else(|| err("HTTP header is malformed"))?;
        match key.to_ascii_lowercase().as_str() {
            "transfer-encoding" => {
                if chunked || !value.trim().eq_ignore_ascii_case("chunked") {
                    return Err(err("Unsupported HTTP transfer encoding"));
                }
                chunked = true;
            }
            "content-length" => {
                let length = value
                    .trim()
                    .parse::<usize>()
                    .map_err(|_| err("Invalid HTTP content length"))?;
                if content_length.is_some_and(|previous| previous != length) {
                    return Err(err("Conflicting HTTP content lengths"));
                }
                content_length = Some(length);
            }
            _ => {}
        }
    }
    if status != 200 {
        return Err(Error(format!("HTTP {status}")));
    }
    if chunked && content_length.is_some() {
        return Err(err("Ambiguous HTTP response framing"));
    }
    if content_length.is_some_and(|length| length > MAX_BODY) {
        return Err(err("Response too large"));
    }
    let mut body = Vec::new();
    if chunked {
        loop {
            let line = read_line(&mut reader)?;
            let size = usize::from_str_radix(line.trim().split(';').next().unwrap_or_default(), 16)
                .map_err(|_| err("chunked 响应长度无效"))?;
            if size == 0 {
                loop {
                    let trailer = read_line(&mut reader)?;
                    count_headers(&mut header_bytes, trailer.len())?;
                    if trailer == "\r\n" {
                        break;
                    }
                }
                break;
            }
            if size > MAX_BODY - body.len() {
                return Err(err("Response too large"));
            }
            let start = body.len();
            body.resize(start + size, 0);
            reader.read_exact(&mut body[start..])?;
            let mut ending = [0; 2];
            reader.read_exact(&mut ending)?;
            if ending != *b"\r\n" {
                return Err(err("Invalid HTTP chunk terminator"));
            }
        }
    } else if let Some(length) = content_length {
        body.resize(length, 0);
        reader.read_exact(&mut body)?;
    } else {
        // Read no more than one byte beyond the limit, even without framing.
        (&mut reader)
            .take((MAX_BODY + 1) as u64)
            .read_to_end(&mut body)?;
        if body.len() > MAX_BODY {
            return Err(err("Response too large"));
        }
    }
    reader.get_ref().budget.remaining()?;
    Ok(serde_json::from_slice(&body)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn serve(response: Vec<u8>) -> (String, std::thread::JoinHandle<()>) {
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            let _ = socket.write_all(&response);
        });
        (url, thread)
    }

    fn probe(response: impl Into<Vec<u8>>) -> Result<Value> {
        let (url, server) = serve(response.into());
        let result = local_json_within(&url, Duration::from_secs(2), &AtomicBool::new(false));
        server.join().unwrap();
        result
    }

    #[test]
    fn accepts_framed_chunked_and_eof_json() {
        for response in [
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}".as_slice(),
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2;ext=yes\r\n{}\r\n0\r\nX-End: yes\r\n\r\n",
            b"HTTP/1.0 200 OK\r\n\r\n{}",
        ] {
            assert!(probe(response).unwrap().is_object());
        }
    }

    #[test]
    fn rejects_oversized_unframed_body_during_read() {
        let mut response = b"HTTP/1.0 200 OK\r\n\r\n".to_vec();
        response.resize(response.len() + MAX_BODY + 1000, b' ');
        assert!(probe(response)
            .unwrap_err()
            .to_string()
            .contains("too large"));
    }

    #[test]
    fn rejects_huge_chunk_without_overflow_or_allocation() {
        let response = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\na\r\n{:x}\r\n",
            usize::MAX
        );
        assert!(probe(response.into_bytes())
            .unwrap_err()
            .to_string()
            .contains("too large"));
    }

    #[test]
    fn rejects_long_lines_and_total_headers() {
        let mut response = b"HTTP/1.1 200 OK\r\nX: ".to_vec();
        response.resize(response.len() + MAX_LINE, b'a');
        response.extend_from_slice(b"\r\n\r\n{}");
        assert!(probe(response)
            .unwrap_err()
            .to_string()
            .contains("line too large"));
        let mut response = String::from("HTTP/1.1 200 OK\r\n");
        for _ in 0..10 {
            response.push_str(&format!("X: {}\r\n", "a".repeat(4000)));
        }
        response.push_str("\r\n{}");
        assert!(probe(response.into_bytes())
            .unwrap_err()
            .to_string()
            .contains("headers too large"));
    }

    #[test]
    fn rejects_bad_framing_and_truncation() {
        for response in [
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nContent-Length: 3\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: nope\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nContent-Length: 2\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\n{}xx0\r\n\r\n",
            "HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\n{}",
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\n",
        ] {
            assert!(probe(response.as_bytes()).is_err());
        }
    }

    #[test]
    fn deadline_applies_to_a_dripping_response() {
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            for part in ["HTTP/1.1 200 OK\r\n", "X: a\r\n", "X: b\r\n", "\r\n", "{}"] {
                std::thread::sleep(Duration::from_millis(60));
                if socket.write_all(part.as_bytes()).is_err() {
                    break;
                }
            }
        });
        let start = Instant::now();
        let result = local_json_within(&url, Duration::from_millis(140), &AtomicBool::new(false));
        let elapsed = start.elapsed();
        assert!(result.is_err());
        assert!(elapsed < Duration::from_millis(800), "elapsed={elapsed:?}");
        server.join().unwrap();
    }

    #[test]
    fn cancel_interrupts_a_blocked_response() {
        let listener = TcpListener::bind((HOST, 0)).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let closed = std::sync::Arc::new(AtomicBool::new(false));
        let cancel = closed.clone();
        let server = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request);
            cancel.store(true, Ordering::SeqCst);
            std::thread::sleep(Duration::from_millis(400));
        });
        let start = Instant::now();
        let result = local_json_within(&url, Duration::from_secs(10), &closed);
        let elapsed = start.elapsed();
        assert!(result.unwrap_err().to_string().contains("正在退出"));
        assert!(elapsed < Duration::from_secs(1), "elapsed={elapsed:?}");
        server.join().unwrap();
    }

    #[test]
    fn only_loopback_and_safe_request_paths_are_accepted() {
        for url in [
            "http://example.com:80/",
            "http://127.0.0.2:80/",
            "http://127.0.0.1:80/a\r\nX: b",
        ] {
            assert!(local_json_within(url, READ_TIMEOUT, &AtomicBool::new(false)).is_err());
        }
        assert!(
            local_json_within("http://127.0.0.1:80/", READ_TIMEOUT, &AtomicBool::new(true))
                .is_err()
        );
        assert!(local_json_within(
            "http://127.0.0.1:80/",
            Duration::ZERO,
            &AtomicBool::new(false)
        )
        .is_err());
    }

    #[test]
    fn accepts_windows_absolute_paths() {
        for path in [
            r"C:\Users\example",
            "C:/Users/example",
            r"D:/",
            r"\\server\share\user",
            r"\\?\C:\Users\example",
        ] {
            assert!(is_windows_absolute(path));
        }
    }

    #[test]
    fn rejects_everything_else() {
        for path in ["C:", "/home/example", r"\Users\example", "", r"1:\Users"] {
            assert!(!is_windows_absolute(path));
        }
    }
}
