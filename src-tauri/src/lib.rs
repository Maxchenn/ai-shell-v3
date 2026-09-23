#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    webview::{
        DownloadEvent, NewWindowResponse, WebviewBuilder, WebviewWindowBuilder,
    },
    window::WindowBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, Window, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as _;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use url::Url;

const WINDOW_LABEL: &str = "main";
const TOOLBAR_LABEL: &str = "toolbar";
const REMOTE_LABEL: &str = "remote";

const TOOLBAR_HEIGHT: u32 = 56;

const DEFAULT_WIDTH: u32 = 1100;
const DEFAULT_HEIGHT: u32 = 760;

const MIN_WIDTH: u32 = 720;
const MIN_HEIGHT: u32 = 480;

const DEFAULT_SHORTCUT: &str = "CTRL+ALT+SPACE";

static POPUP_COUNTER: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Site {
    id: String,
    name: String,
    url: String,
    builtin: bool,
}

#[derive(Clone, Debug, Serialize)]
struct DownloadNotice {
    name: String,
    success: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct SavedSettings {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    selected_site_id: String,
    sites: Vec<Site>,
    pinned: bool,
    shortcut: String,
    autostart: bool,
}

impl Default for SavedSettings {
    fn default() -> Self {
        Self {
            x: 120,
            y: 100,
            width: DEFAULT_WIDTH,
            height: DEFAULT_HEIGHT,
            selected_site_id: "deepseek".into(),
            sites: vec![
                Site {
                    id: "deepseek".into(),
                    name: "DeepSeek".into(),
                    url: "https://chat.deepseek.com/".into(),
                    builtin: true,
                },
                Site {
                    id: "chatgpt".into(),
                    name: "ChatGPT".into(),
                    url: "https://chatgpt.com/".into(),
                    builtin: true,
                },
                Site {
                    id: "claude".into(),
                    name: "Claude".into(),
                    url: "https://claude.ai/".into(),
                    builtin: true,
                },
                Site {
                    id: "gemini".into(),
                    name: "Gemini".into(),
                    url: "https://gemini.google.com/".into(),
                    builtin: true,
                },
            ],
            pinned: false,
            shortcut: DEFAULT_SHORTCUT.into(),
            autostart: false,
        }
    }
}

struct AppState {
    settings: Mutex<SavedSettings>,
    save_path: PathBuf,
    fullscreen: Mutex<bool>,
    saved_windowed_size: Mutex<PhysicalSize<u32>>,
    saved_windowed_position: Mutex<PhysicalPosition<i32>>,
    toolbar_height: Mutex<u32>,
    geometry_revision: AtomicU64,
}

fn state(app: &AppHandle) -> tauri::Result<Arc<AppState>> {
    app.try_state::<Arc<AppState>>()
        .map(|s| s.inner().clone())
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!("应用状态尚未初始化"))
        })
}

fn load_settings(path: &PathBuf) -> SavedSettings {
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<SavedSettings>(&text).ok())
        .map(|mut settings| {
            if settings.sites.is_empty() {
                settings = SavedSettings::default();
            }

            if !settings
                .sites
                .iter()
                .any(|site| site.id == settings.selected_site_id)
            {
                settings.selected_site_id = settings
                    .sites
                    .first()
                    .map(|site| site.id.clone())
                    .unwrap_or_else(|| "deepseek".into());
            }

            settings.width = settings.width.max(MIN_WIDTH);
            settings.height = settings.height.max(MIN_HEIGHT);

            if settings.shortcut.trim().is_empty() {
                settings.shortcut = DEFAULT_SHORTCUT.into();
            }

            settings
        })
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle) -> tauri::Result<()> {
    let st = state(app)?;
    let snapshot = st.settings.lock().unwrap().clone();

    if let Some(parent) = st.save_path.parent() {
        fs::create_dir_all(parent)?;
    }

    let json = serde_json::to_string_pretty(&snapshot)?;
    fs::write(&st.save_path, json)?;

    Ok(())
}

fn selected_site(app: &AppHandle) -> tauri::Result<Site> {
    let st = state(app)?;
    let settings = st.settings.lock().unwrap();

    settings
        .sites
        .iter()
        .find(|site| site.id == settings.selected_site_id)
        .cloned()
        .ok_or_else(|| {
            tauri::Error::Anyhow(anyhow::anyhow!("找不到当前网站"))
        })
}

fn toggle_visibility_inner(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?;

    // 最小化状态也属于 visible，所以必须优先恢复最小化。
    if window.is_minimized()? {
        window.unminimize()?;
        window.show()?;
        window.set_focus()?;
        return Ok(());
    }

    if window.is_visible()? {
        save_window_geometry(app)?;
        window.hide()?;
    } else {
        window.show()?;
        window.set_focus()?;
    }

    Ok(())
}

fn save_window_geometry(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?;

    if window.is_fullscreen().unwrap_or(false) {
        return Ok(());
    }

    let position = window.outer_position()?;
    let size = window.inner_size()?;

    let st = state(app)?;
    let mut settings = st.settings.lock().unwrap();

    settings.x = position.x;
    settings.y = position.y;
    settings.width = size.width.max(MIN_WIDTH);
    settings.height = size.height.max(MIN_HEIGHT);

    drop(settings);
    save_settings(app)
}

fn schedule_save_window_geometry(app: &AppHandle) {
    let Ok(st) = state(app) else {
        return;
    };

    let revision = st.geometry_revision.fetch_add(1, Ordering::Relaxed) + 1;
    let app_handle = app.clone();

    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));

        let Ok(st) = state(&app_handle) else {
            return;
        };

        if st.geometry_revision.load(Ordering::Relaxed) == revision {
            let _ = save_window_geometry(&app_handle);
        }
    });
}

fn layout_webviews(window: &Window, toolbar_height: u32) -> tauri::Result<()> {
    let size = window.inner_size()?;
    let actual_toolbar_height = if toolbar_height > TOOLBAR_HEIGHT {
        size.height
    } else {
        toolbar_height.min(size.height)
    };

    if let Some(webview) = window.get_webview(TOOLBAR_LABEL) {
        webview.set_position(PhysicalPosition::new(0, 0))?;
        webview.set_size(PhysicalSize::new(
            size.width,
            actual_toolbar_height,
        ))?;
    }

    if let Some(webview) = window.get_webview(REMOTE_LABEL) {
        webview.set_position(PhysicalPosition::new(0, actual_toolbar_height))?;
        webview.set_size(PhysicalSize::new(
            size.width,
            size.height.saturating_sub(actual_toolbar_height),
        ))?;
    }

    Ok(())
}

fn toggle_fullscreen(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?;

    let st = state(app)?;
    let mut fullscreen = st.fullscreen.lock().unwrap();

    if *fullscreen || window.is_fullscreen()? {
        window.set_fullscreen(false)?;

        let saved_size = *st.saved_windowed_size.lock().unwrap();
        let saved_position = *st.saved_windowed_position.lock().unwrap();

        window.set_size(saved_size)?;
        window.set_position(saved_position)?;

        *fullscreen = false;

        let toolbar_height = *st.toolbar_height.lock().unwrap();
        layout_webviews(&window, toolbar_height)?;
    } else {
        *st.saved_windowed_size.lock().unwrap() = window.inner_size()?;
        *st.saved_windowed_position.lock().unwrap() = window.outer_position()?;

        window.set_fullscreen(true)?;
        *fullscreen = true;

        let toolbar_height = *st.toolbar_height.lock().unwrap();
        layout_webviews(&window, toolbar_height)?;
    }

    Ok(())
}

fn navigate_to_selected(app: &AppHandle) -> tauri::Result<()> {
    let site = selected_site(app)?;

    let remote = app
        .get_webview(REMOTE_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到网页视图")))?;

    let url = Url::parse(&site.url)
        .map_err(|e| tauri::Error::Anyhow(anyhow::Error::from(e)))?;

    remote.navigate(url)?;
    Ok(())
}

fn register_shortcut(app: &AppHandle, shortcut_text: &str) -> tauri::Result<()> {
    let shortcut = Shortcut::try_from(shortcut_text.trim()).map_err(|e| {
        tauri::Error::Anyhow(anyhow::anyhow!(
            "快捷键格式无效：{}",
            e
        ))
    })?;

    app.global_shortcut().register(shortcut).map_err(|e| {
        tauri::Error::Anyhow(anyhow::anyhow!(
            "快捷键注册失败：{}",
            e
        ))
    })?;

    Ok(())
}

fn maybe_unregister_shortcut(app: &AppHandle, shortcut_text: &str) {
    if let Ok(shortcut) = Shortcut::try_from(shortcut_text.trim()) {
        let _ = app.global_shortcut().unregister(shortcut);
    }
}

fn sanitize_filename(name: &str) -> String {
    let mut result = name
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            ch if ch.is_control() => '_',
            ch => ch,
        })
        .collect::<String>();

    result = result.trim().trim_end_matches('.').to_string();

    if result.is_empty() {
        "download".into()
    } else {
        result
    }
}

fn unique_download_path(dir: &Path, filename: &str) -> PathBuf {
    let original = PathBuf::from(filename);
    let stem = original
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("download");
    let ext = original
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| format!(".{s}"))
        .unwrap_or_default();

    let mut candidate = dir.join(filename);

    if !candidate.exists() {
        return candidate;
    }

    for index in 1..=9999 {
        let name = format!("{stem} ({index}){ext}");
        candidate = dir.join(name);

        if !candidate.exists() {
            return candidate;
        }
    }

    candidate
}

fn choose_download_destination(
    app: &AppHandle,
    url: &Url,
    destination: &mut PathBuf,
) {
    let Ok(download_dir) = app.path().download_dir() else {
        return;
    };

    let filename = destination
        .file_name()
        .and_then(|name| name.to_str())
        .map(sanitize_filename)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            url.path_segments()
                .and_then(|segments| segments.last())
                .map(sanitize_filename)
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "download".into());

    *destination = unique_download_path(&download_dir, &filename);
}


fn download_display_name(url: &Url, path: Option<&Path>) -> String {
    path
        .and_then(|p| p.file_name())
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .filter(|name| !name.is_empty())
        .or_else(|| {
            url.path_segments()
                .and_then(|segments| segments.last())
                .map(sanitize_filename)
                .filter(|name| !name.is_empty())
        })
        .unwrap_or_else(|| "download".into())
}

fn emit_download_started(app: &AppHandle, url: &Url, destination: &Path) {
    let payload = DownloadNotice {
        name: download_display_name(url, Some(destination)),
        success: true,
    };
    let _ = app.emit("download-started", payload);
}

fn emit_download_finished(
    app: &AppHandle,
    url: &Url,
    path: Option<&Path>,
    success: bool,
) {
    let payload = DownloadNotice {
        name: download_display_name(url, path),
        success,
    };
    let _ = app.emit("download-finished", payload);
}

const REMOTE_INIT: &str = r#"
(() => {
  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.ctrlKey || e.altKey || e.metaKey) {
      return;
    }

    if (e.key.toLowerCase() !== 'f') {
      return;
    }

    const target = e.target;
    const tag = target && target.tagName;

    if (
      target?.isContentEditable ||
      ['INPUT', 'TEXTAREA', 'SELECT'].includes(tag)
    ) {
      return;
    }

    e.preventDefault();
    location.href = 'aishell://fullscreen';
  }, true);
})();
"#;

fn popup_geometry(app: &AppHandle) -> Option<(f64, f64, f64, f64)> {
    let main = app.get_window(WINDOW_LABEL)?;
    let monitor = main.current_monitor().ok().flatten()?;
    let scale = monitor.scale_factor().max(0.1);
    let work = monitor.work_area();

    let work_width = work.size.width as f64 / scale;
    let work_height = work.size.height as f64 / scale;
    let work_x = work.position.x as f64 / scale;
    let work_y = work.position.y as f64 / scale;

    let width = work_width.min(960.0).max(760.0);
    let x = work_x + (work_width - width) / 2.0;

    Some((x, work_y, width, work_height))
}

fn build_main_window(
    app: &tauri::AppHandle,
    settings: &SavedSettings,
) -> tauri::Result<Window> {
    let window = WindowBuilder::new(app, WINDOW_LABEL)
        .title("AI Shell")
        .position(settings.x as f64, settings.y as f64)
        .inner_size(settings.width as f64, settings.height as f64)
        .min_inner_size(MIN_WIDTH as f64, MIN_HEIGHT as f64)
        .resizable(true)
        .decorations(false)
        .transparent(true)
        .shadow(true)
        .visible(!std::env::args().any(|arg| arg == "--hidden"))
        .always_on_top(settings.pinned)
        .build()?;

    let inner = window.inner_size()?;

    let toolbar_builder = WebviewBuilder::new(
        TOOLBAR_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .focused(true)
    .initialization_script(
        "document.documentElement.dataset.aiShellToolbar='1';",
    );

    window.add_child(
        toolbar_builder,
        PhysicalPosition::new(0, 0),
        PhysicalSize::new(inner.width, TOOLBAR_HEIGHT),
    )?;

    let site = settings
        .sites
        .iter()
        .find(|site| site.id == settings.selected_site_id)
        .cloned()
        .unwrap_or_else(|| SavedSettings::default().sites[0].clone());

    let remote_url = Url::parse(&site.url)
        .map_err(|e| tauri::Error::Anyhow(anyhow::Error::from(e)))?;

    let download_app = app.clone();
    let popup_app = app.clone();

    let remote_builder = WebviewBuilder::new(
        REMOTE_LABEL,
        WebviewUrl::External(remote_url),
    )
    .initialization_script(REMOTE_INIT)
    .on_download(move |_webview, event| {
        match event {
            DownloadEvent::Requested { url, destination } => {
                choose_download_destination(&download_app, &url, destination);
                emit_download_started(&download_app, &url, destination);
            }
            DownloadEvent::Finished { url, path, success } => {
                emit_download_finished(&download_app, &url, path.as_deref(), success);
            }
            _ => {}
        }

        true
    })
    .on_new_window(move |url, features| {
        let label = format!(
            "popup-{}",
            POPUP_COUNTER.fetch_add(1, Ordering::Relaxed)
        );

        let popup_download_app = popup_app.clone();
        let mut builder = WebviewWindowBuilder::new(
            &popup_app,
            label,
            WebviewUrl::External(url.clone()),
        )
        .window_features(features)
        .title(url.as_str());

        if let Some((x, y, width, height)) = popup_geometry(&popup_app) {
            builder = builder
                .inner_size(width, height)
                .position(x, y);
        } else {
            builder = builder
                .inner_size(960.0, 760.0)
                .center();
        }

        let builder = builder.on_download(move |_webview, event| {
            match event {
                DownloadEvent::Requested { url, destination } => {
                    choose_download_destination(
                        &popup_download_app,
                        &url,
                        destination,
                    );
                    emit_download_started(
                        &popup_download_app,
                        &url,
                        destination,
                    );
                }
                DownloadEvent::Finished { url, path, success } => {
                    emit_download_finished(
                        &popup_download_app,
                        &url,
                        path.as_deref(),
                        success,
                    );
                }
                _ => {}
            }

            true
        });

        match builder.build() {
            Ok(window) => NewWindowResponse::Create { window },
            Err(_) => NewWindowResponse::Deny,
        }
    })
    .on_navigation({
        let app = app.clone();

        move |url| {
            if url.scheme() == "aishell"
                && url.host_str() == Some("fullscreen")
            {
                let _ = toggle_fullscreen(&app);
                return false;
            }

            true
        }
    });

    window.add_child(
        remote_builder,
        PhysicalPosition::new(0, TOOLBAR_HEIGHT),
        PhysicalSize::new(
            inner.width,
            inner.height.saturating_sub(TOOLBAR_HEIGHT),
        ),
    )?;

    Ok(window)
}

fn init_state(app: &tauri::AppHandle) -> tauri::Result<()> {
    let path = app.path().app_data_dir()?.join("settings.json");
    let settings = load_settings(&path);

    let initial_size = PhysicalSize::new(
        settings.width.max(MIN_WIDTH),
        settings.height.max(MIN_HEIGHT),
    );

    app.manage(Arc::new(AppState {
        settings: Mutex::new(settings.clone()),
        save_path: path,
        fullscreen: Mutex::new(false),
        saved_windowed_size: Mutex::new(initial_size),
        saved_windowed_position: Mutex::new(
            PhysicalPosition::new(settings.x, settings.y),
        ),
        toolbar_height: Mutex::new(TOOLBAR_HEIGHT),
        geometry_revision: AtomicU64::new(0),
    }));

    Ok(())
}

fn make_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    let show = MenuItemBuilder::with_id("show", "显示 / 隐藏").build(app)?;
    let quit = MenuItemBuilder::with_id("quit", "退出 AI Shell").build(app)?;

    let menu = MenuBuilder::new(app)
        .item(&show)
        .separator()
        .item(&quit)
        .build()?;

    let mut tray = TrayIconBuilder::with_id("main-tray")
        .menu(&menu)
        .tooltip("AI Shell");

    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    tray.on_menu_event(|app, event| match event.id().as_ref() {
        "show" => {
            let _ = toggle_visibility_inner(app);
        }

        "quit" => {
            let _ = save_window_geometry(app);
            app.exit(0);
        }

        _ => {}
    })
    .build(app)?;

    Ok(())
}

#[tauri::command]
fn get_settings(app: AppHandle) -> tauri::Result<SavedSettings> {
    Ok(state(&app)?.settings.lock().unwrap().clone())
}

#[tauri::command]
fn set_pinned(
    app: AppHandle,
    pinned: bool,
) -> tauri::Result<SavedSettings> {
    {
        let st = state(&app)?;
        st.settings.lock().unwrap().pinned = pinned;
    }

    app.get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?
        .set_always_on_top(pinned)?;

    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn set_shortcut(
    app: AppHandle,
    shortcut: String,
) -> tauri::Result<SavedSettings> {
    let shortcut = shortcut.trim().to_string();

    if shortcut.is_empty() {
        return Err(tauri::Error::Anyhow(anyhow::anyhow!("快捷键不能为空")));
    }

    let old_shortcut = {
        let st = state(&app)?;
        let shortcut = st.settings.lock().unwrap().shortcut.clone();
        shortcut
    };

    if old_shortcut.eq_ignore_ascii_case(&shortcut) {
        return get_settings(app);
    }

    // 先注册新的，成功以后再注销旧的，避免中途没有可用快捷键。
    register_shortcut(&app, &shortcut)?;

    maybe_unregister_shortcut(&app, &old_shortcut);

    {
        let st = state(&app)?;
        st.settings.lock().unwrap().shortcut = shortcut;
    }

    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn set_autostart(
    app: AppHandle,
    enabled: bool,
) -> tauri::Result<SavedSettings> {
    state(&app)?.settings.lock().unwrap().autostart = enabled;

    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn select_site(
    app: AppHandle,
    id: String,
) -> tauri::Result<SavedSettings> {
    {
        let st = state(&app)?;
        let mut settings = st.settings.lock().unwrap();

        if !settings.sites.iter().any(|site| site.id == id) {
            return Err(tauri::Error::Anyhow(anyhow::anyhow!("网站不存在")));
        }

        settings.selected_site_id = id;
    }

    navigate_to_selected(&app)?;
    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn add_site(
    app: AppHandle,
    name: String,
    url: String,
) -> tauri::Result<SavedSettings> {
    let name = name.trim().to_string();

    if name.is_empty() {
        return Err(tauri::Error::Anyhow(anyhow::anyhow!("名称不能为空")));
    }

    let parsed = Url::parse(&url)
        .map_err(|e| tauri::Error::Anyhow(anyhow::Error::from(e)))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(tauri::Error::Anyhow(anyhow::anyhow!(
            "只支持 HTTP/HTTPS 网站"
        )));
    }

    let id = format!("custom-{}", uuid_like(&url));

    {
        let st = state(&app)?;
        let mut settings = st.settings.lock().unwrap();

        if settings.sites.iter().any(|site| site.url == url) {
            return Err(tauri::Error::Anyhow(anyhow::anyhow!(
                "这个网址已经存在"
            )));
        }

        settings.sites.push(Site {
            id: id.clone(),
            name,
            url: url.clone(),
            builtin: false,
        });

        settings.selected_site_id = id;
    }

    navigate_to_selected(&app)?;
    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn remove_site(
    app: AppHandle,
    id: String,
) -> tauri::Result<SavedSettings> {
    {
        let st = state(&app)?;
        let mut settings = st.settings.lock().unwrap();

        if settings
            .sites
            .iter()
            .find(|site| site.id == id)
            .map(|site| site.builtin)
            .unwrap_or(true)
        {
            return Err(tauri::Error::Anyhow(anyhow::anyhow!(
                "内置网站不能删除"
            )));
        }

        settings.sites.retain(|site| site.id != id);

        if settings.selected_site_id == id {
            settings.selected_site_id = settings
                .sites
                .first()
                .map(|site| site.id.clone())
                .unwrap_or_else(|| "deepseek".into());
        }
    }

    navigate_to_selected(&app)?;
    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn update_site(
    app: AppHandle,
    id: String,
    name: String,
    url: String,
) -> tauri::Result<SavedSettings> {
    let name = name.trim().to_string();

    if name.is_empty() {
        return Err(tauri::Error::Anyhow(anyhow::anyhow!(
            "名称不能为空"
        )));
    }

    let parsed = Url::parse(&url)
        .map_err(|e| tauri::Error::Anyhow(anyhow::Error::from(e)))?;

    if !matches!(parsed.scheme(), "http" | "https") {
        return Err(tauri::Error::Anyhow(anyhow::anyhow!(
            "只支持 HTTP/HTTPS 网站"
        )));
    }

    let selected;

    {
        let st = state(&app)?;
        let mut settings = st.settings.lock().unwrap();

        if settings
            .sites
            .iter()
            .any(|site| site.id != id && site.url == url)
        {
            return Err(tauri::Error::Anyhow(anyhow::anyhow!(
                "这个网址已经存在"
            )));
        }

        let site = settings
            .sites
            .iter_mut()
            .find(|site| site.id == id)
            .ok_or_else(|| {
                tauri::Error::Anyhow(anyhow::anyhow!("网站不存在"))
            })?;

        site.name = name;
        site.url = url;
        selected = settings.selected_site_id == id;
    }

    if selected {
        navigate_to_selected(&app)?;
    }

    save_settings(&app)?;
    get_settings(app)
}

#[tauri::command]
fn set_toolbar_height(
    app: AppHandle,
    height: u32,
) -> tauri::Result<()> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?;

    {
        let st = state(&app)?;
        *st.toolbar_height.lock().unwrap() = height;
    }

    layout_webviews(&window, height)
}

#[tauri::command]
fn set_settings_mode(
    app: AppHandle,
    open: bool,
) -> tauri::Result<()> {
    let window = app
        .get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?;

    let height = if open {
        window.inner_size()?.height
    } else {
        TOOLBAR_HEIGHT
    };

    {
        let st = state(&app)?;
        *st.toolbar_height.lock().unwrap() = height;
    }

    layout_webviews(&window, height)
}

#[tauri::command]
fn hide_window(app: AppHandle) -> tauri::Result<()> {
    save_window_geometry(&app)?;

    app.get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?
        .hide()?;

    Ok(())
}

#[tauri::command]
fn toggle_visibility(app: AppHandle) -> tauri::Result<()> {
    toggle_visibility_inner(&app)
}

#[tauri::command]
fn minimize_window(app: AppHandle) -> tauri::Result<()> {
    save_window_geometry(&app)?;

    app.get_window(WINDOW_LABEL)
        .ok_or_else(|| tauri::Error::Anyhow(anyhow::anyhow!("找不到主窗口")))?
        .minimize()?;

    Ok(())
}

#[tauri::command]
fn toggle_fullscreen_command(app: AppHandle) -> tauri::Result<()> {
    toggle_fullscreen(&app)
}

fn uuid_like(s: &str) -> String {
    use std::hash::{Hash, Hasher};

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    s.hash(&mut hasher);

    format!("{:x}", hasher.finish())
}

pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(
            tauri_plugin_single_instance::init(|app, _args, _cwd| {
                let _ = toggle_visibility_inner(app);
            }),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed {
                        let _ = toggle_visibility_inner(app);
                    }
                })
                .build(),
        )
        .plugin(
            tauri_plugin_autostart::Builder::new()
                .args(["--hidden"])
                .build(),
        )
        .invoke_handler(tauri::generate_handler![
            get_settings,
            set_pinned,
            set_shortcut,
            set_autostart,
            select_site,
            add_site,
            update_site,
            remove_site,
            set_toolbar_height,
            set_settings_mode,
            hide_window,
            toggle_visibility,
            minimize_window,
            toggle_fullscreen_command
        ])
        .setup(|app| {
            let app_handle = app.handle().clone();

            init_state(&app_handle)?;

            let mut settings = state(&app_handle)?
                .settings
                .lock()
                .unwrap()
                .clone();

            // Alt+Space 在 Windows 上更容易和系统/其他程序冲突。
            // 如果旧版本正好保存的是 Alt+Space 且启动注册失败，
            // 自动迁移到更不容易冲突的 Ctrl+Alt+Space。
            if let Err(error) = register_shortcut(
                &app_handle,
                &settings.shortcut,
            ) {
                if settings.shortcut.eq_ignore_ascii_case("ALT+SPACE") {
                    if register_shortcut(
                        &app_handle,
                        DEFAULT_SHORTCUT,
                    ).is_ok() {
                        settings.shortcut = DEFAULT_SHORTCUT.into();

                        {
                            let st = state(&app_handle)?;
                            *st.settings.lock().unwrap() = settings.clone();
                        }

                        let _ = save_settings(&app_handle);
                    } else {
                        eprintln!("快捷键注册失败：{error}");
                    }
                } else {
                    eprintln!("快捷键注册失败：{error}");
                }
            }

            let window = build_main_window(&app_handle, &settings)?;
            make_tray(&app_handle)?;

            window.on_window_event({
                let app_handle = app_handle.clone();

                move |event| match event {
                    WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                        if let Some(window) =
                            app_handle.get_window(WINDOW_LABEL)
                        {
                            if let Ok(st) = state(&app_handle) {
                                let toolbar_height =
                                    *st.toolbar_height.lock().unwrap();

                                let _ = layout_webviews(
                                    &window,
                                    toolbar_height,
                                );
                            }

                            schedule_save_window_geometry(&app_handle);
                        }
                    }

                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();

                        let _ = save_window_geometry(&app_handle);

                        if let Some(window) =
                            app_handle.get_window(WINDOW_LABEL)
                        {
                            let _ = window.hide();
                        }
                    }

                    WindowEvent::Destroyed => {
                        let _ = save_window_geometry(&app_handle);
                    }

                    _ => {}
                }
            });

            if settings.autostart {
                let _ = app.autolaunch();
            }

            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building AI Shell")
        .run(|_app, _event| {});
}
