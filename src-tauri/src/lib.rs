//! Pi Launcher — Tauri v2 port.
//!
//! The Rust side owns configuration, backend lifecycle, window and tray.
//! The bundled frontend is a single static loading page; Pi Web itself is
//! loaded as an external origin with no IPC permissions granted to it.

mod autostart;
mod backend;
mod config;
mod http;
mod process;
mod util;

use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent};
use tauri::{
    App, AppHandle, Manager, RunEvent, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
    WindowEvent, Wry,
};
use tauri_plugin_positioner::{Position, WindowExt};

use backend::{PiBackend, ServerInfo};
use util::{err, lock, log, log_error, resolve_data_dir, APP_NAME};

/// Label of the frameless tray popover window.
const TRAY_WINDOW: &str = "tray-menu";
/// How long after opening the popover its own blur is ignored.
const TRAY_GRACE: Duration = Duration::from_millis(300);
/// Host used by the popover to signal actions without any Tauri IPC permission.
const TRAY_ACTION_HOST: &str = "pi-launcher.tray";
/// Held only by worker threads. A caller racing another build waits for that
/// window instead of losing an early request to show the menu.
static TRAY_CREATION: Mutex<()> = Mutex::new(());
/// Bound early right-click workers while the popover is still being built.
static TRAY_OPEN_PENDING: AtomicBool = AtomicBool::new(false);

/// Injected into every document. Keyboard zoom is signalled with window.open so
/// the remote Pi Web page needs no Tauri IPC permissions at all.
const ZOOM_SCRIPT: &str = r#"
(function () {
  document.addEventListener('keydown', function (event) {
    if (!event.ctrlKey || event.altKey || event.metaKey) return;
    var action = null;
    if (event.key === '+' || event.key === '=') action = 'in';
    else if (event.key === '-') action = 'out';
    else if (event.key === '0') action = 'reset';
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    try { window.open('https://pi-launcher.zoom/' + action, '_blank'); } catch (error) {}
  }, true);
})();
"#;

fn internal_origin(windows: bool) -> (&'static str, &'static str) {
    if windows {
        ("http", "tauri.localhost")
    } else {
        ("tauri", "localhost")
    }
}

/// Match the actual bundled origin, not just a scheme or hostname. In
/// particular, HTTPS, custom ports, userinfo and the asset protocol are not
/// trusted. `Url` normalizes an explicit HTTP default port (80) to `None`.
fn is_internal_url_for_platform(url: &Url, windows: bool) -> bool {
    let (scheme, host) = internal_origin(windows);
    url.scheme() == scheme
        && url.host_str() == Some(host)
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_internal_url(url: &Url) -> bool {
    is_internal_url_for_platform(url, cfg!(windows))
}

fn is_loading_url(url: &Url) -> bool {
    is_internal_url(url) && matches!(url.path(), "/" | "/index.html")
}

fn is_tray_url(url: &Url) -> bool {
    is_internal_url(url) && url.path() == "/tray.html"
}

fn is_external_url(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https")
        && url.host_str().is_some()
        && url.username().is_empty()
        && url.password().is_none()
}

fn is_server_url(url: &Url, server_url: &str) -> bool {
    is_external_url(url)
        && Url::parse(server_url)
            .ok()
            .filter(is_external_url)
            .map(|base| base.origin() == url.origin())
            .unwrap_or(false)
}

/// Parse our window.open signals strictly; lookalike hosts, schemes, ports,
/// credentials, nested paths and URL suffixes must never become UI actions.
fn action_from_url<'a>(url: &'a Url, host: &str) -> Option<&'a str> {
    if url.scheme() != "https"
        || url.host_str() != Some(host)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let action = url.path().strip_prefix('/')?;
    if action.is_empty() || action.contains('/') {
        None
    } else {
        Some(action)
    }
}

/// A single OS-opener worker with a small, nonblocking queue. Neither a slow
/// shell association nor repeated web content callbacks can grow a thread pool.
enum OpenTarget {
    Browser(String),
    Directory(PathBuf),
}

fn start_opener(state_dir: &Path) -> Option<mpsc::SyncSender<OpenTarget>> {
    let (sender, receiver) = mpsc::sync_channel::<OpenTarget>(4);
    let worker_dir = state_dir.to_path_buf();
    match std::thread::Builder::new()
        .name("os-opener".into())
        .spawn(move || {
            while let Ok(target) = receiver.recv() {
                let (result, failure) = match target {
                    OpenTarget::Browser(url) => (open::that(url), "Cannot open browser"),
                    OpenTarget::Directory(path) => (open::that(path), "Cannot open directory"),
                };
                if result.is_err() {
                    // OS opener errors may embed their command line, including
                    // URL credentials/query secrets. Never log the error/URL.
                    log(&worker_dir, failure);
                }
            }
        }) {
        Ok(_) => Some(sender),
        Err(_) => {
            log(state_dir, "Cannot start OS opener worker");
            None
        }
    }
}

fn queue_open(context: &Context, target: OpenTarget) {
    if let Some(opener) = &context.opener {
        if opener.try_send(target).is_err() {
            log(
                &context.state_dir,
                "OS opener request dropped: queue full or worker stopped",
            );
        }
    } else {
        log(&context.state_dir, "OS opener unavailable");
    }
}

#[derive(Clone)]
struct Context {
    state_dir: Arc<PathBuf>,
    /// WebView2 profile directory. Deliberately **not** under `state_dir`: a
    /// Chromium profile is hundreds of MB of cache and must not live in the
    /// roaming AppData tree.
    webview_dir: Arc<PathBuf>,
    opener: Option<mpsc::SyncSender<OpenTarget>>,
    /// Refreshed only when opening the tray or clicking its startup switch.
    autostart: Arc<Mutex<autostart::Status>>,
    /// "Stop doing work": set when a quit is requested or startup has failed.
    closed: Arc<AtomicBool>,
    /// "A quit has already been requested", so the tray cannot queue two.
    quitting: Arc<AtomicBool>,
    zoom: Arc<Mutex<f64>>,
    server: Arc<Mutex<Option<ServerInfo>>>,
    shutdown: Arc<Mutex<Option<mpsc::Sender<()>>>>,
    /// Last phase pushed to the loading page. Replayed on every page load so a
    /// phase emitted before the document was ready is never lost.
    last_phase: Arc<Mutex<Option<serde_json::Value>>>,
    /// Startup error, if any. Kept here (rather than only in the message box)
    /// so the loading page can show it and a late page load cannot overwrite it
    /// with a stale phase.
    last_error: Arc<Mutex<Option<String>>>,
    /// Timestamps used to ignore the blur caused by showing the popover and to
    /// distinguish "click the tray icon again to dismiss" from a fresh open.
    tray_shown_at: Arc<Mutex<Option<Instant>>>,
    tray_hidden_at: Arc<Mutex<Option<Instant>>>,
}

impl Context {
    fn new(state_dir: PathBuf, webview_dir: PathBuf) -> Self {
        Self {
            opener: start_opener(&state_dir),
            state_dir: Arc::new(state_dir),
            webview_dir: Arc::new(webview_dir),
            autostart: Arc::new(Mutex::new(autostart::Status::unknown(
                "打开菜单后读取登录自启状态。",
            ))),
            closed: Arc::new(AtomicBool::new(false)),
            quitting: Arc::new(AtomicBool::new(false)),
            zoom: Arc::new(Mutex::new(1.0)),
            server: Arc::new(Mutex::new(None)),
            shutdown: Arc::new(Mutex::new(None)),
            last_phase: Arc::new(Mutex::new(None)),
            last_error: Arc::new(Mutex::new(None)),
            tray_shown_at: Arc::new(Mutex::new(None)),
            tray_hidden_at: Arc::new(Mutex::new(None)),
        }
    }
}

pub fn run() {
    util::mark_start();
    let state_dir = match resolve_data_dir() {
        Ok(directory) => directory,
        Err(error) => {
            process::show_message_box(APP_NAME, &error.to_string());
            return;
        }
    };
    log(&state_dir, "Launcher starting");
    let webview_dir = util::resolve_webview_dir(&state_dir);
    let context = Context::new(state_dir.clone(), webview_dir);
    let setup_context = context.clone();

    let built = tauri::Builder::default()
        // Must be the first plugin registered.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_app_window(app);
        }))
        // Required for tray-relative positions: on_tray_event stores the icon
        // rect in this plugin's managed state.
        .plugin(tauri_plugin_positioner::init())
        .setup(move |app| {
            app.manage(setup_context.clone());
            log(&setup_context.state_dir, "Setup begin");

            // Backend first, window second. Creating the WebView2 controller
            // costs well over a second; the startup thread only needs the main
            // window at the very end (to navigate), and waits for it there.
            let (sender, receiver) = mpsc::channel();
            *lock(&setup_context.shutdown) = Some(sender);
            let thread_context = setup_context.clone();
            let handle = app.handle().clone();
            std::thread::spawn(move || startup(thread_context, handle, receiver));
            log(&setup_context.state_dir, "Startup thread spawned");

            build_window(app, &setup_context)?;
            log(&setup_context.state_dir, "Main window created");

            build_tray(app)?;
            log(&setup_context.state_dir, "Tray icon ready");
            Ok(())
        })
        .on_window_event(|window, event| match event {
            // Closing the main window hides it; the backend keeps running.
            WindowEvent::CloseRequested { api, .. } => {
                api.prevent_close();
                let _ = window.hide();
            }
            // A popover behaves like a native context menu: it closes as soon
            // as it loses focus. Ignore the blur emitted right after showing.
            WindowEvent::Focused(false) if window.label() == TRAY_WINDOW => {
                let app = window.app_handle().clone();
                let Some(context) = app.try_state::<Context>() else {
                    return;
                };
                let shown_at = *lock(&context.tray_shown_at);
                let settled = shown_at
                    .map(|at| at.elapsed() >= TRAY_GRACE)
                    .unwrap_or(true);
                if settled {
                    hide_tray_menu(&app, &context);
                    return;
                }
                // Showing the popover emits a blur of its own, so hiding right
                // away would make it impossible to click. Ignoring the event
                // outright is just as wrong in the other direction: clicking
                // anywhere else inside the grace window used to leave the
                // always-on-top popover stuck on screen until the tray icon was
                // right-clicked again. Re-check once, when the window has had
                // its chance to take focus.
                let context = context.inner().clone();
                std::thread::spawn(move || {
                    if let Some(at) = shown_at {
                        let wait = TRAY_GRACE.saturating_sub(at.elapsed());
                        std::thread::sleep(wait + Duration::from_millis(20));
                    }
                    // A later open resets the timestamp; only act on the one
                    // this event belonged to.
                    if *lock(&context.tray_shown_at) != shown_at {
                        return;
                    }
                    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
                        if window.is_visible().unwrap_or(false)
                            && !window.is_focused().unwrap_or(true)
                        {
                            hide_tray_menu(&app, &context);
                        }
                    }
                });
            }
            _ => {}
        })
        .build(tauri::generate_context!());
    // A panic here used to be invisible: release builds are `windows_subsystem
    // = "windows"`, so the only symptom was "double-clicking does nothing".
    // The usual cause is a missing or broken WebView2 runtime.
    let app = match built {
        Ok(app) => app,
        Err(error) => {
            log_error(&state_dir, "Cannot build application", &error);
            process::show_message_box(
                APP_NAME,
                &format!(
                    "无法创建应用窗口：{error}\n\n\
                     常见原因：没有安装 Microsoft Edge WebView2 运行时，或数据目录不可写。\n\
                     日志：{}",
                    state_dir.join("launcher.log").display()
                ),
            );
            return;
        }
    };

    app.run(|handle, event| {
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            api.prevent_exit();
            if let Some(state) = handle.try_state::<Context>() {
                request_quit(&state, handle);
            }
        }
    });
}

/// The loading page's `--canvas` value for the current system theme. Kept in
/// sync with `ui/index.html` by hand; it is only on screen for a frame or two
/// before the page paints over it.
fn window_background() -> tauri::window::Color {
    if process::prefers_dark() {
        tauri::window::Color(0x14, 0x15, 0x18, 0xff)
    } else {
        tauri::window::Color(0xf5, 0xf5, 0xf3, 0xff)
    }
}

fn build_window(app: &mut App, context: &Context) -> tauri::Result<()> {
    let navigation_context = context.clone();
    let new_window_context = context.clone();
    let new_window_handle = app.handle().clone();
    let page_load_context = context.clone();

    WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(APP_NAME)
        .inner_size(1280.0, 860.0)
        .min_inner_size(900.0, 600.0)
        // Paint the window in the loading page's own canvas colour. Without
        // this the window shows a plain white surface for the ~1 s WebView2
        // needs to produce its first frame, which reads as a flash in dark mode
        // and as a "the app is broken" blank window in light mode.
        .background_color(window_background())
        .center()
        // Keep the WebView2 profile out of the roaming tree; it is a cache and
        // is large enough to make profile sync fail.
        .data_directory(context.webview_dir.as_ref().clone())
        // Native file-drop interception consumes WebView2's HTML5 drag/drop
        // events. Pi Web needs the standard DOM drop path instead.
        .disable_drag_drop_handler()
        .initialization_script(ZOOM_SCRIPT)
        .on_document_title_changed(|window, _title| {
            let _ = window.set_title(APP_NAME);
        })
        .on_page_load(move |window, payload| {
            let zoom = *lock(&page_load_context.zoom);
            let _ = window.set_zoom(zoom);
            // Only the bundled loading page understands the phase payload; the
            // remote Pi Web document must stay untouched.
            let internal = is_loading_url(payload.url());
            // Replay once the document is parsed. `Started` is WebView2's
            // ContentLoading, which fires before the DOM exists — `document.body`
            // is still null there, so the old replay threw and rendered nothing.
            if internal && payload.event() == PageLoadEvent::Finished {
                // The only milestone between "window exists" and "backend ready"
                // that a user can actually see. Without it, the log cannot tell
                // an early window with nothing painted from a healthy startup.
                log(
                    &page_load_context.state_dir,
                    &format!("Page rendered: {}", payload.url()),
                );
                let error = lock(&page_load_context.last_error).clone();
                match error {
                    Some(message) => apply_error(&window, &message),
                    None => {
                        let phase = lock(&page_load_context.last_phase).clone();
                        if let Some(phase) = phase {
                            apply_phase(&window, &phase);
                        }
                    }
                }
            }
        })
        .on_navigation(move |url| {
            // The bundled loading page lives on the internal origin.
            if is_loading_url(url) {
                return true;
            }
            // Other bundled documents (notably tray.html) do not belong in
            // the main window, and must not be sent to the system browser.
            if is_internal_url(url) || !is_external_url(url) {
                return false;
            }
            let allowed = lock(&navigation_context.server)
                .as_ref()
                .map(|server| is_server_url(url, &server.url))
                .unwrap_or(false);
            if allowed {
                true
            } else {
                open_external(url.as_str(), &navigation_context);
                false
            }
        })
        .on_new_window(move |url, _features| {
            if let Some(action) = action_from_url(&url, "pi-launcher.zoom") {
                if matches!(action, "in" | "out" | "reset") {
                    apply_zoom(&new_window_handle, &new_window_context, action);
                }
            } else if !matches!(url.host_str(), Some("pi-launcher.zoom" | TRAY_ACTION_HOST)) {
                open_external(url.as_str(), &new_window_context);
            }
            NewWindowResponse::Deny
        })
        .build()?;
    Ok(())
}

/// The tray "menu" is a real, frameless webview window so it can be styled
/// with CSS. It is created hidden, on demand, and only ever from a background
/// thread: window creation blocks until the main thread answers, so calling it
/// from the main thread (setup or a tray event) would stall or deadlock.
fn ensure_tray_menu_window(app: &AppHandle) -> bool {
    if app.get_webview_window(TRAY_WINDOW).is_some() {
        return true;
    }
    let _creation = lock(&TRAY_CREATION);
    // Another worker may have completed its build after our first lookup.
    if app.get_webview_window(TRAY_WINDOW).is_some() {
        return true;
    }
    // Same profile as the main window on purpose: a second, implicit profile
    // would live in the default WebView2 location with its own locks and cache.
    let Some(webview_dir) = app
        .try_state::<Context>()
        .map(|context| context.webview_dir.as_ref().clone())
    else {
        return false;
    };
    let action_app = app.clone();
    let built = WebviewWindowBuilder::new(app, TRAY_WINDOW, WebviewUrl::App("tray.html".into()))
        .title(APP_NAME)
        .data_directory(webview_dir)
        .inner_size(316.0, 404.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .shadow(false)
        .visible(false)
        .focused(false)
        .on_navigation(|url| {
            // Only the bundled page may load here. Everything else is denied.
            is_tray_url(url)
        })
        .on_page_load(|window, payload| {
            // Creation/show-time eval can run before tray.js defines its
            // receiver. Replay the *current* state once that receiver exists.
            if payload.event() == PageLoadEvent::Finished && is_tray_url(payload.url()) {
                update_tray_state(window.app_handle());
            }
        })
        .on_new_window(move |url, _features| {
            if let Some(action) = action_from_url(&url, TRAY_ACTION_HOST) {
                if let Some(context) = action_app.try_state::<Context>() {
                    handle_tray_action(&action_app, &context, action);
                }
            }
            NewWindowResponse::Deny
        })
        .build();
    match built {
        Ok(_) => {
            if let Some(context) = app.try_state::<Context>() {
                log(&context.state_dir, "Tray popover created");
            }
            true
        }
        Err(error) => {
            if let Some(context) = app.try_state::<Context>() {
                log_error(&context.state_dir, "Cannot create tray popover", &error);
            }
            false
        }
    }
}

/// Push the current status into the popover. `eval` is a Rust-side API, so the
/// popover needs no IPC capability at all.
fn update_tray_state(app: &AppHandle) {
    let Some(context) = app.try_state::<Context>() else {
        return;
    };
    let (ready, endpoint, version, label) = match lock(&context.server).as_ref() {
        Some(server) => (
            true,
            server
                .url
                .trim_start_matches("http://")
                .trim_start_matches("https://")
                .to_string(),
            match &server.version {
                Some(version) => format!("v{version}"),
                None => "外部服务".to_string(),
            },
            server.label.clone().unwrap_or_default(),
        ),
        None => (false, "等待连接".to_string(), String::new(), String::new()),
    };
    let autostart = lock(&context.autostart).clone();
    let payload = serde_json::json!({
        "autostart": autostart,
        "ready": ready,
        "endpoint": endpoint,
        "version": version,
        "label": label,
    });
    let script = format!("if (window.__setTrayState) window.__setTrayState({payload});");
    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
        let _ = window.eval(script);
    }
}

fn build_tray(app: &mut App) -> tauri::Result<()> {
    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip(APP_NAME)
        .show_menu_on_left_click(false)
        .on_tray_icon_event(|tray, event| {
            // Forward every event so positioner learns the icon's rect.
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            let TrayIconEvent::Click {
                button,
                button_state: MouseButtonState::Up,
                ..
            } = event
            else {
                return;
            };
            let app = tray.app_handle();
            match button {
                MouseButton::Left => show_app_window(app),
                MouseButton::Right => {
                    if let Some(context) = app.try_state::<Context>() {
                        toggle_tray_menu(app, &context);
                    }
                }
                MouseButton::Middle => {}
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

fn toggle_tray_menu(app: &AppHandle, context: &Context) {
    let Some(window) = app.get_webview_window(TRAY_WINDOW) else {
        // Popover is normally created right after the main page starts
        // loading; this only happens on a very early right-click. Build it on a
        // worker thread, then open it. Only one such request may wait on the
        // creation lock, even if the icon is clicked repeatedly.
        if TRAY_OPEN_PENDING.swap(true, Ordering::SeqCst) {
            return;
        }
        let app = app.clone();
        std::thread::spawn(move || {
            if ensure_tray_menu_window(&app) {
                if let (Some(context), Some(window)) = (
                    app.try_state::<Context>(),
                    app.get_webview_window(TRAY_WINDOW),
                ) {
                    if !context.quitting.load(Ordering::SeqCst) {
                        show_tray_menu(&app, &context, &window);
                    }
                }
            }
            TRAY_OPEN_PENDING.store(false, Ordering::SeqCst);
        });
        return;
    };
    if window.is_visible().unwrap_or(false) {
        hide_tray_menu(app, context);
        return;
    }
    // Right-clicking the icon first blurs (and hides) the popover. Treat that
    // same click as a dismiss instead of immediately reopening it.
    let just_hidden = lock(&context.tray_hidden_at)
        .map(|at| at.elapsed() < Duration::from_millis(400))
        .unwrap_or(false);
    if just_hidden {
        return;
    }
    show_tray_menu(app, context, &window);
}

fn show_tray_menu(app: &AppHandle, context: &Context, window: &WebviewWindow<Wry>) {
    // Read-only: opening the menu never opts the user into login startup.
    // Serialize with toggles so an older read cannot overwrite their result.
    {
        let mut status = lock(&context.autostart);
        *status = autostart::status();
    }
    update_tray_state(app);
    // TrayCenter keeps the popover above the icon (or below it if the taskbar
    // is at the top); the constrained variant also keeps it on-screen.
    let positioned = window
        .move_window_constrained(Position::TrayCenter)
        .or_else(|_| window.move_window(Position::TrayBottomCenter))
        .or_else(|_| window.move_window(Position::BottomRight));
    if let Err(error) = positioned {
        log_error(
            context.state_dir.as_ref(),
            "Cannot position tray menu",
            &error,
        );
    }
    let _ = window.show();
    let _ = window.set_focus();
    *lock(&context.tray_shown_at) = Some(Instant::now());
}

fn hide_tray_menu(app: &AppHandle, context: &Context) {
    if let Some(window) = app.get_webview_window(TRAY_WINDOW) {
        let _ = window.hide();
    }
    *lock(&context.tray_hidden_at) = Some(Instant::now());
}

fn handle_tray_action(app: &AppHandle, context: &Context, action: &str) {
    // Keep the login-startup switch open for verified state feedback.
    let keep_open = action == "autostart-toggle";
    if !keep_open {
        hide_tray_menu(app, context);
    }
    match action {
        "show" => show_app_window(app),
        "browser" => {
            let url = lock(&context.server).as_ref().map(|s| s.url.clone());
            if let Some(url) = url {
                open_external(&url, context);
            }
        }
        "copy" => {
            let url = lock(&context.server).as_ref().map(|s| s.url.clone());
            if let Some(url) = url {
                copy_server_url(app, context, &url);
            }
        }
        "config-dir" | "log-dir" => {
            queue_open(
                context,
                OpenTarget::Directory(context.state_dir.as_ref().clone()),
            );
        }
        "autostart-toggle" => {
            // This dispatch is reachable only from the bundled tray window's
            // on_new_window handler, never from the remote main document.
            let mut status = lock(&context.autostart);
            *status = autostart::toggle();
            drop(status);
            update_tray_state(app);
        }
        "quit" => request_quit(context, app),
        "dismiss" => {}
        _ => {}
    }
}

fn apply_zoom(app: &AppHandle, context: &Context, action: &str) {
    // Keyboard zoom remains scoped to the main window, not the tray menu.
    let zoom = {
        let mut current = lock(&context.zoom);
        let next = match action {
            "in" => *current + 0.05,
            "out" => *current - 0.05,
            "reset" => 1.0,
            "125" => 1.25,
            _ => return,
        };
        *current = (next.clamp(0.75, 2.0) * 100.0).round() / 100.0;
        *current
    };
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_zoom(zoom);
    }
}

fn show_app_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        show_window(&window);
    }
}

/// The main window is created on the main thread; this thread may get here
/// first when the backend starts quickly.
fn wait_for_main_window(app: &AppHandle, timeout: Duration) -> Option<WebviewWindow<Wry>> {
    let started = Instant::now();
    loop {
        if let Some(window) = app.get_webview_window("main") {
            return Some(window);
        }
        if started.elapsed() > timeout {
            return None;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn show_window(window: &tauri::WebviewWindow<Wry>) {
    if window.is_minimized().unwrap_or(false) {
        let _ = window.unminimize();
    }
    let _ = window.show();
    let _ = window.set_focus();
}

fn open_external(url: &str, context: &Context) {
    // Validate before queuing: invalid schemes cannot consume worker capacity
    // or invoke arbitrary system protocol handlers.
    if let Ok(url) = Url::parse(url) {
        if is_external_url(&url) && !is_internal_url(&url) {
            queue_open(context, OpenTarget::Browser(url.into()));
        }
    }
}

fn copy_server_url(app: &AppHandle, context: &Context, url: &str) {
    #[cfg(windows)]
    {
        // EmptyClipboard requires a real owner HWND for SetClipboardData to
        // succeed. Prefer the long-lived main window; the tray is a fallback.
        let owner = ["main", TRAY_WINDOW].iter().find_map(|label| {
            app.get_webview_window(label)
                .and_then(|window| window.hwnd().ok())
                .map(|handle| handle.0 as windows_sys::Win32::Foundation::HWND)
                .filter(|handle| !handle.is_null())
        });
        match owner {
            Some(owner) => {
                if !process::set_clipboard(owner, url) {
                    log(
                        &context.state_dir,
                        "Cannot copy server address to clipboard",
                    );
                }
            }
            None => log(
                &context.state_dir,
                "Cannot copy server address: no owner window",
            ),
        }
    }
    #[cfg(not(windows))]
    {
        let _ = (app, url);
        log(&context.state_dir, "Clipboard is only supported on Windows");
    }
}

fn emit_phase(app: &AppHandle, phase: &str, port: u16) {
    let status = match phase {
        "environment" => "正在检查运行环境",
        "backend" => "正在连接本地服务",
        _ => "正在打开工作空间",
    };
    let payload = serde_json::json!({
        "phase": phase,
        "status": status,
        "endpoint": format!("127.0.0.1:{port}"),
    });
    if let Some(context) = app.try_state::<Context>() {
        *lock(&context.last_phase) = Some(payload.clone());
    }
    // `eval` is the only channel. `app.emit` used to push an IPC message into
    // *every* webview — including the remote Pi Web document — and the loading
    // page no longer has a script that could listen for it.
    if let Some(window) = app.get_webview_window("main") {
        apply_phase(&window, &payload);
    }
    update_tray_state(app);
}

/// Push one phase into the loading page. `eval` is a Rust-side API, so the page
/// needs no IPC permission.
fn apply_phase(window: &WebviewWindow<Wry>, payload: &serde_json::Value) {
    let script = r#"(function(){if(!document.body)return;const s=__STATE__;document.body.dataset.phase=s.phase;const t=document.getElementById('status-text');if(t)t.textContent=s.status;const e=document.getElementById('endpoint');if(e)e.textContent=s.endpoint;const steps=document.querySelectorAll('[data-step]');for(let i=0;i<steps.length;i++){if(steps[i].dataset.step===s.phase)steps[i].setAttribute('aria-current','step');else steps[i].removeAttribute('aria-current');}})()"#
        .replace("__STATE__", &payload.to_string());
    eval_loading_page(window, &script);
}

/// Render a startup failure inside the loading page.
///
/// The native message box is the primary channel, but it can be refused (locked
/// down desktops) and it disappears as soon as the process exits. The page keeps
/// the reason and the log path on screen instead of sitting on "正在连接本地服务"
/// forever.
fn apply_error(window: &WebviewWindow<Wry>, message: &str) {
    let payload = serde_json::json!({ "message": message });
    let script = r#"(function(){if(!document.body)return;const s=__STATE__;document.body.dataset.phase='failed';const h=document.getElementById('heading');if(h)h.textContent='启动失败';const t=document.getElementById('status-text');if(t)t.textContent='无法启动本地服务';const box=document.getElementById('error-box');if(box){box.textContent=s.message;box.hidden=false;}const bar=document.getElementById('status-bar');if(bar)bar.hidden=true;})()"#
        .replace("__STATE__", &payload.to_string());
    eval_loading_page(window, &script);
}

/// Check both before scheduling eval and inside the script. Navigation can
/// commit between the Rust URL lookup and WebView2 executing the queued script;
/// in that case the remote document must not be modified by a stale phase/error.
fn eval_loading_page(window: &WebviewWindow<Wry>, script: &str) {
    if !showing_loading_page(window) {
        return;
    }
    let (scheme, host) = internal_origin(cfg!(windows));
    let protocol = format!("{scheme}:");
    let guarded = format!(
        // Read the unforgeable Location object directly: a remote document
        // could replace the global URL constructor before a queued eval runs.
        "(function(){{const l=window.location;\
         if(l.protocol!=={protocol:?}||l.hostname!=={host:?}||l.port!==''||\
         (l.pathname!=='/'&&l.pathname!=='/index.html'))return;{script}}})()"
    );
    let _ = window.eval(guarded);
}

/// Whether the main window is currently showing the bundled loading page rather
/// than the remote Pi Web document.
fn showing_loading_page(window: &WebviewWindow<Wry>) -> bool {
    window
        .url()
        .map(|url| is_loading_url(&url))
        .unwrap_or(false)
}

fn startup(context: Context, app: AppHandle, receiver: mpsc::Receiver<()>) {
    let state_dir = context.state_dir.as_ref().clone();
    let mut backend = match PiBackend::new(state_dir.clone(), context.closed.clone()) {
        Ok(backend) => backend,
        Err(error) => return fatal(&context, &app, &state_dir, &error),
    };
    log(&state_dir, "Config loaded, backend handle ready");
    let port = backend.port();
    emit_phase(&app, "environment", port);
    emit_phase(&app, "backend", port);

    let server = match backend.start(port) {
        Ok(server) => server,
        Err(error) => {
            if context.closed.load(Ordering::SeqCst) {
                let _ = backend.stop(port, None);
                app.exit(0);
                return;
            }
            return fatal(&context, &app, &state_dir, &error);
        }
    };
    *lock(&context.server) = Some(server.clone());
    emit_phase(&app, "workspace", port);

    let url = match Url::parse(&server.url) {
        Ok(url) => url,
        Err(error) => return fatal(&context, &app, &state_dir, &error),
    };
    // The window is built on the main thread right after this thread starts, so
    // it may not exist yet when the backend wins the race.
    let window = match wait_for_main_window(&app, Duration::from_secs(20)) {
        Some(window) => window,
        None => return fatal(&context, &app, &state_dir, &err("主窗口不存在")),
    };
    if let Err(error) = window.navigate(url) {
        return fatal(&context, &app, &state_dir, &error);
    }

    log(
        &state_dir,
        &format!(
            "{APP_NAME} ready at {}; version={}",
            server.url,
            server.version.as_deref().unwrap_or("external")
        ),
    );

    // Now that the main page is loading, build the tray popover on this
    // (worker) thread and seed it with the current state. Doing it here keeps a
    // second WebView2 controller off the startup critical path.
    ensure_tray_menu_window(&app);
    update_tray_state(&app);

    if backend.spawned() {
        let child = backend.child_handle();
        let watch_context = context.clone();
        let watch_app = app.clone();
        let watch_dir = state_dir.clone();
        // The backend keeps owning the `Child`; this thread only polls it. Handing
        // ownership over (the old `take_child`) left nothing to kill if the
        // record file disappeared, which leaked the backend *and* the port.
        std::thread::spawn(move || loop {
            let status = {
                let mut guard = lock(&child);
                match guard.as_mut() {
                    Some(child) => child.try_wait().ok().flatten(),
                    None => return,
                }
            };
            if let Some(status) = status {
                // `quitting` covers the window between the tray asking to quit
                // and this thread noticing the exit: without it, a normal quit
                // could pop a bogus "unexpected exit" dialog that races the
                // pending `app.exit(0)`.
                if !watch_context.quitting.load(Ordering::SeqCst) {
                    let code = status.code().unwrap_or(-1);
                    fatal(
                        &watch_context,
                        &watch_app,
                        &watch_dir,
                        &err(format!("Pi Web 意外退出：code={code}")),
                    );
                }
                return;
            }
            if watch_context.closed.load(Ordering::SeqCst) {
                return;
            }
            std::thread::sleep(Duration::from_millis(250));
        });
    }

    // Stay alive until the tray asks to quit; then stop only our own backend.
    let _ = receiver.recv();
    if server.owned {
        if let Err(error) = backend.stop(port, server.info.as_ref()) {
            log_error(&state_dir, "Failed to stop backend", &error);
        }
    }
    app.exit(0);
}

fn request_quit(context: &Context, app: &AppHandle) {
    // Guard on a dedicated flag: `closed` is also set by `fatal`, and a failed
    // start must not make the tray's "退出" a no-op.
    if context.quitting.swap(true, Ordering::SeqCst) {
        return;
    }
    context.closed.store(true, Ordering::SeqCst);
    let sender = lock(&context.shutdown).take();
    match sender {
        Some(sender) => {
            // The startup thread is gone once it has failed; then there is
            // nothing to wait for and the send fails immediately.
            if sender.send(()).is_err() {
                app.exit(0);
            }
        }
        None => app.exit(0),
    }
}

fn fatal(context: &Context, app: &AppHandle, state_dir: &Path, error: &dyn Display) {
    let message = format!(
        "{}\n\n日志：{}",
        error,
        state_dir.join("launcher.log").display()
    );
    log_error(state_dir, "Fatal error", error);
    context.closed.store(true, Ordering::SeqCst);

    // Record the failure first: a page that loads after this point replays it
    // (see `on_page_load`) instead of a stale "正在连接本地服务".
    if let Some(state) = app.try_state::<Context>() {
        *lock(&state.last_error) = Some(error.to_string());
        // The backend is gone; a stale `server` made the tray keep showing a
        // green "running" dot and offer "copy address"/"open in browser" for a
        // port nothing listens on any more.
        *lock(&state.server) = None;
    }
    update_tray_state(app);
    // Show it in the window as well, but only while the loading page is up —
    // writing into the remote Pi Web document would be an intrusion.
    if let Some(window) = app.get_webview_window("main") {
        if showing_loading_page(&window) {
            apply_error(&window, &error.to_string());
            let _ = window.show();
            let _ = window.set_focus();
        }
    }

    log(state_dir, "Showing startup error dialog");
    if process::show_message_box(APP_NAME, &message) {
        // The user has read the dialog; there is nothing left to keep alive.
        // `app.exit` only queues the shutdown, so returning matters: without it
        // the "did not display" branch below would log a contradiction.
        log(state_dir, "Error acknowledged; exiting");
        app.exit(1);
        return;
    }
    // If Windows refused the dialog, stay alive: the loading page still shows
    // the reason, and the tray can quit. Exiting here would leave a machine
    // that cannot display message boxes with no way to learn what happened.
    log(
        state_dir,
        "Windows did not display the error dialog; keeping the window open",
    );
}

#[cfg(test)]
mod navigation_tests {
    use super::*;

    fn url(value: &str) -> Url {
        Url::parse(value).unwrap()
    }

    #[test]
    fn bundled_origin_matches_the_platform_and_default_port_only() {
        for value in [
            "http://tauri.localhost/",
            "http://tauri.localhost/index.html",
            "http://tauri.localhost:80/tray.html",
            "HTTP://TAURI.LOCALHOST/index.html?view=1#status",
        ] {
            assert!(is_internal_url_for_platform(&url(value), true), "{value}");
            assert!(!is_internal_url_for_platform(&url(value), false), "{value}");
        }
        for value in ["tauri://localhost/", "tauri://localhost/tray.html"] {
            assert!(is_internal_url_for_platform(&url(value), false), "{value}");
            assert!(!is_internal_url_for_platform(&url(value), true), "{value}");
        }
    }

    #[test]
    fn malicious_bundled_origin_variants_are_untrusted() {
        for value in [
            "https://tauri.localhost/index.html",
            "https://tauri.localhost:443/index.html",
            "http://tauri.localhost:443/index.html",
            "http://tauri.localhost:30141/index.html",
            "http://tauri.localhost.evil.test/index.html",
            "http://tauri.localhost./index.html",
            "http://evil.test/tauri.localhost/index.html",
            "http://tauri.localhost@evil.test/index.html",
            "http://evil.test@tauri.localhost/index.html",
            "http://user:secret@tauri.localhost/index.html",
            "http://:secret@tauri.localhost/index.html",
            "ftp://tauri.localhost/index.html",
            "asset://tauri.localhost/index.html",
            "tauri://evil.test/index.html",
            "tauri://tauri.localhost/index.html",
            "tauri://localhost.evil.test/index.html",
            "tauri://localhost:80/index.html",
            "tauri://localhost:30141/index.html",
            "tauri://user:secret@localhost/index.html",
            "tauri:///index.html",
            "tauri:index.html",
            "file:///index.html",
            "data:text/html,tauri://localhost",
            "javascript:location='http://tauri.localhost'",
        ] {
            let parsed = url(value);
            assert!(
                !is_internal_url_for_platform(&parsed, true),
                "Windows: {value}"
            );
            assert!(
                !is_internal_url_for_platform(&parsed, false),
                "Other: {value}"
            );
        }
    }

    #[test]
    fn bundled_documents_cannot_navigate_into_each_other() {
        let (scheme, host) = internal_origin(cfg!(windows));
        let base = format!("{scheme}://{host}");
        for path in ["/", "/index.html", "/index.html#status"] {
            let parsed = url(&format!("{base}{path}"));
            assert!(is_loading_url(&parsed), "{path}");
            assert!(!is_tray_url(&parsed), "{path}");
        }
        assert!(is_tray_url(&url(&format!("{base}/tray.html"))));
        assert!(!is_loading_url(&url(&format!("{base}/tray.html"))));
        for path in [
            "/other.html",
            "/tray.html/",
            "/%74ray.html",
            "/index.html/tray.html",
        ] {
            let parsed = url(&format!("{base}{path}"));
            assert!(!is_tray_url(&parsed), "{path}");
            assert!(!is_loading_url(&parsed), "{path}");
        }
    }

    #[test]
    fn server_navigation_requires_the_exact_http_origin() {
        let base = "http://127.0.0.1:30141/";
        for value in [base, "http://127.0.0.1:30141/session/123?tab=chat#bottom"] {
            assert!(is_server_url(&url(value), base), "{value}");
        }
        for value in [
            "http://127.0.0.1/",
            "http://127.0.0.1:30142/",
            "https://127.0.0.1:30141/",
            "http://localhost:30141/",
            "http://127.0.0.1.evil.test:30141/",
            "http://127.0.0.1:30141@evil.test/",
            "http://user:secret@127.0.0.1:30141/",
            "ftp://127.0.0.1:30141/",
            "tauri://localhost/",
        ] {
            assert!(!is_server_url(&url(value), base), "{value}");
        }
        assert!(!is_server_url(&url(base), "not a URL"));
        assert!(!is_server_url(&url(base), "ftp://127.0.0.1:30141/"));
    }

    #[test]
    fn action_signals_require_exact_authority_and_single_path() {
        assert_eq!(
            action_from_url(&url("https://pi-launcher.tray/show"), TRAY_ACTION_HOST),
            Some("show")
        );
        assert_eq!(
            action_from_url(&url("https://pi-launcher.zoom/in"), "pi-launcher.zoom"),
            Some("in")
        );
        for value in [
            "http://pi-launcher.tray/show",
            "tauri://pi-launcher.tray/show",
            "https://pi-launcher.tray:444/show",
            "https://pi-launcher.tray.evil.test/show",
            "https://pi-launcher.tray./show",
            "https://pi-launcher.tray@evil.test/show",
            "https://user:secret@pi-launcher.tray/show",
            "https://pi-launcher.tray/show?quit",
            "https://pi-launcher.tray/show#quit",
            "https://pi-launcher.tray//show",
            "https://pi-launcher.tray/show/quit",
            "https://pi-launcher.tray/show/",
            "https://pi-launcher.tray/",
        ] {
            assert_eq!(
                action_from_url(&url(value), TRAY_ACTION_HOST),
                None,
                "{value}"
            );
        }
    }

    #[test]
    fn external_opener_rejects_non_web_schemes_and_credentials() {
        for value in ["https://example.test/path?q=1", "http://localhost:30141/"] {
            assert!(is_external_url(&url(value)), "{value}");
        }
        for value in [
            "file:///C:/Windows/notepad.exe",
            "javascript:alert(1)",
            "data:text/html,test",
            "mailto:person@example.test",
            "tauri://localhost/",
            "https://user:secret@example.test/",
        ] {
            assert!(!is_external_url(&url(value)), "{value}");
        }
    }
}
