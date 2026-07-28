use serde::{Deserialize, Serialize};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position, Size,
    Webview, WebviewBuilder, WebviewWindow, WebviewWindowBuilder, WindowEvent,
    menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder},
    utils::config::WebviewUrl,
};

const HEADER_HEIGHT: f64 = 38.0;
const MACOS_TITLEBAR_HEIGHT: f64 = 28.0;
const WINDOW_PADDING: f64 = 2.0;
const CARD_PADDING: f64 = 8.0;
const MIN_WINDOW_WIDTH: f64 = 320.0;
const MIN_WINDOW_HEIGHT: f64 = 640.0;
const NEW_WINDOW_OFFSET: f64 = 28.0;
const SETTINGS_FILE_NAME: &str = "settings.json";
const TRADINGVIEW_DATA_STORE_ID: [u8; 16] = *b"tvbrowser-store1";
const JST_OFFSET_SECONDS: u128 = 9 * 60 * 60;
const CAPTURE_MARGIN_SECONDS: u128 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct WorkArea {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct WindowSnapshot {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct AppSettings {
    theme: String,
    always_on_top: bool,
    site_url: String,
    card_width: f64,
    card_height: f64,
    window_width: f64,
    window_height: f64,
    window_x: Option<f64>,
    window_y: Option<f64>,
    width_resize_origin: String,
    capture_interval_min: u32,
    capture_file_name: String,
    capture_directory: String,
    wide_mode_width: f64,
    narrow_mode_width: f64,
}

impl Default for AppSettings {
    fn default() -> Self {
        let home = std::env::var("HOME").unwrap_or_else(|_| String::from("/tmp"));
        Self {
            theme: String::from("dark"),
            always_on_top: false,
            site_url: String::from("https://www.tradingview.com"),
            card_width: 980.0,
            card_height: 680.0,
            window_width: 1320.0,
            window_height: 920.0,
            window_x: None,
            window_y: None,
            width_resize_origin: String::from("right"),
            capture_interval_min: 5,
            capture_file_name: String::from("capture"),
            capture_directory: Path::new(&home)
                .join("Downloads")
                .to_string_lossy()
                .into_owned(),
            wide_mode_width: 1920.0,
            narrow_mode_width: 425.0,
        }
    }
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsPatch {
    theme: Option<String>,
    always_on_top: Option<bool>,
    site_url: Option<String>,
    width_resize_origin: Option<String>,
    capture_interval_min: Option<u32>,
    capture_file_name: Option<String>,
    capture_directory: Option<String>,
    wide_mode_width: Option<f64>,
    narrow_mode_width: Option<f64>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct LayoutMetrics {
    header_height: f64,
    card_x: f64,
    card_y: f64,
    card_width: f64,
    card_height: f64,
    content_x: f64,
    content_y: f64,
    content_width: f64,
    content_height: f64,
    card_padding: f64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureState {
    active_window_label: Option<String>,
    paused: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct CaptureToggleResult {
    status: String,
    reason: Option<String>,
}

#[derive(Clone)]
struct WindowContext {
    window: WebviewWindow,
    trading_view: Webview,
    local: AppSettings,
    suspended: bool,
    latest_layout: LayoutMetrics,
}

struct RuntimeState {
    settings: AppSettings,
    startup_warning: Option<String>,
    windows: HashMap<String, WindowContext>,
    next_window_id: u64,
    active_capture_label: Option<String>,
    capture_paused: bool,
    capture_task: Option<tauri::async_runtime::JoinHandle<()>>,
    exit_confirmation_open: bool,
    window_persistence_suppressed: HashSet<String>,
}

struct AppState(Mutex<RuntimeState>);

struct SettingsLoadResult {
    settings: AppSettings,
    warning: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
enum ExitRequestAction {
    Allow,
    Prevent,
    Prompt,
}

fn exit_request_action(capture_active: bool, confirmation_open: bool) -> ExitRequestAction {
    if !capture_active {
        ExitRequestAction::Allow
    } else if confirmation_open {
        ExitRequestAction::Prevent
    } else {
        ExitRequestAction::Prompt
    }
}

fn is_https_url(value: &str) -> bool {
    value
        .parse::<tauri::Url>()
        .map(|url| url.scheme() == "https")
        .unwrap_or(false)
}

fn sanitize_file_name(value: &str) -> Option<String> {
    let value = value.trim().trim_end_matches(".png").trim();
    let invalid = value.is_empty()
        || value.chars().any(|ch| {
            matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || ch.is_control()
        });
    (!invalid).then(|| value.to_string())
}

fn sanitize_window_coordinate(value: Option<f64>) -> Option<f64> {
    value.filter(|coordinate| coordinate.is_finite() && coordinate.abs() <= f64::from(i32::MAX))
}

fn intersection_area(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    area: WorkArea,
) -> u64 {
    let left = i64::from(position.x).max(i64::from(area.x));
    let top = i64::from(position.y).max(i64::from(area.y));
    let right = (i64::from(position.x) + i64::from(size.width))
        .min(i64::from(area.x) + i64::from(area.width));
    let bottom = (i64::from(position.y) + i64::from(size.height))
        .min(i64::from(area.y) + i64::from(area.height));
    let width = (right - left).max(0) as u64;
    let height = (bottom - top).max(0) as u64;
    width * height
}

fn distance_to_work_area(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    area: WorkArea,
) -> f64 {
    let center_x = f64::from(position.x) + f64::from(size.width) / 2.0;
    let center_y = f64::from(position.y) + f64::from(size.height) / 2.0;
    let left = f64::from(area.x);
    let top = f64::from(area.y);
    let right = left + f64::from(area.width);
    let bottom = top + f64::from(area.height);
    let dx = if center_x < left {
        left - center_x
    } else if center_x > right {
        center_x - right
    } else {
        0.0
    };
    let dy = if center_y < top {
        top - center_y
    } else if center_y > bottom {
        center_y - bottom
    } else {
        0.0
    };
    dx * dx + dy * dy
}

fn clamp_window_position(
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    work_areas: &[WorkArea],
) -> PhysicalPosition<i32> {
    let Some(mut selected) = work_areas.first().copied() else {
        return position;
    };
    let mut selected_overlap = intersection_area(position, size, selected);
    let mut selected_distance = distance_to_work_area(position, size, selected);
    for area in &work_areas[1..] {
        let overlap = intersection_area(position, size, *area);
        let distance = distance_to_work_area(position, size, *area);
        if overlap > selected_overlap
            || (overlap == selected_overlap && distance < selected_distance)
        {
            selected = *area;
            selected_overlap = overlap;
            selected_distance = distance;
        }
    }

    let left = i64::from(selected.x);
    let top = i64::from(selected.y);
    let max_x =
        left + (i64::from(selected.width) - i64::from(size.width).min(i64::from(selected.width)));
    let max_y =
        top + (i64::from(selected.height) - i64::from(size.height).min(i64::from(selected.height)));
    PhysicalPosition::new(
        i64::from(position.x).clamp(left, max_x) as i32,
        i64::from(position.y).clamp(top, max_y) as i32,
    )
}

fn constrain_window_to_work_area(
    app: &tauri::AppHandle,
    window: &WebviewWindow,
) -> Result<bool, String> {
    let work_areas = app
        .available_monitors()
        .map_err(|error| error.to_string())?
        .into_iter()
        .map(|monitor| {
            let area = monitor.work_area();
            WorkArea {
                x: area.position.x,
                y: area.position.y,
                width: area.size.width,
                height: area.size.height,
            }
        })
        .collect::<Vec<_>>();
    if work_areas.is_empty() {
        return Ok(false);
    }

    let position = window.outer_position().map_err(|error| error.to_string())?;
    let size = window.outer_size().map_err(|error| error.to_string())?;
    let corrected = clamp_window_position(position, size, &work_areas);
    if corrected == position {
        return Ok(false);
    }
    window
        .set_position(Position::Physical(corrected))
        .map_err(|error| error.to_string())?;
    Ok(true)
}

fn capture_output_path(settings: &AppSettings) -> PathBuf {
    Path::new(&settings.capture_directory).join(format!("{}.png", settings.capture_file_name))
}

fn open_capture_output(path: &Path, create: bool) -> Result<fs::File, String> {
    let mut options = OpenOptions::new();
    options.write(true).create(create);
    #[cfg(unix)]
    options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);

    let file = options
        .open(path)
        .map_err(|error| format!("Capture output file could not be opened safely: {error}"))?;
    let metadata = file
        .metadata()
        .map_err(|error| format!("Capture output metadata could not be read: {error}"))?;
    if !metadata.file_type().is_file() {
        return Err(String::from(
            "Capture output path must be a writable regular file",
        ));
    }
    Ok(file)
}

fn write_capture_output(path: &Path, contents: &[u8]) -> Result<(), String> {
    let mut file = open_capture_output(path, true)?;
    file.set_len(0)
        .map_err(|error| format!("Capture output file could not be truncated: {error}"))?;
    file.write_all(contents)
        .map_err(|error| format!("Capture output file could not be written: {error}"))
}

fn validate_capture_destination(settings: &AppSettings) -> Result<(), String> {
    let directory = Path::new(&settings.capture_directory);
    if !directory.is_dir() {
        return Err(String::from(
            "Download destination must be an existing directory",
        ));
    }

    let probe_seed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut probe = None;
    let mut last_error = None;
    for attempt in 0..10 {
        let path = directory.join(format!(
            ".tv-browser-write-test-{}-{probe_seed}-{attempt}",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => {
                probe = Some((path, file));
                break;
            }
            Err(error) => last_error = Some(error),
        }
    }

    let (probe_path, mut probe_file) = probe.ok_or_else(|| {
        format!(
            "Download destination is not writable: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_else(|| String::from("failed to create a validation file"))
        )
    })?;
    let write_result = probe_file.write_all(&[0]);
    drop(probe_file);
    let cleanup_result = fs::remove_file(&probe_path);

    if let Err(error) = write_result {
        return Err(format!("Download destination is not writable: {error}"));
    }
    if let Err(error) = cleanup_result {
        return Err(format!(
            "Download destination validation file could not be removed: {error}"
        ));
    }

    let output_path = capture_output_path(settings);
    match fs::symlink_metadata(&output_path) {
        Ok(metadata) => {
            if !metadata.file_type().is_file() {
                return Err(String::from(
                    "Capture output path must be a writable regular file and cannot be a symbolic link",
                ));
            }
            open_capture_output(&output_path, false)
                .map_err(|error| format!("Capture output file is not writable: {error}"))?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Capture output path could not be inspected: {error}"
            ));
        }
    }

    Ok(())
}

fn sanitize_settings(mut settings: AppSettings) -> AppSettings {
    let defaults = AppSettings::default();
    if !matches!(settings.theme.as_str(), "dark" | "light") {
        settings.theme = defaults.theme;
    }
    if !is_https_url(&settings.site_url) || settings.site_url.len() > 64 {
        settings.site_url = defaults.site_url;
    }
    if !matches!(settings.width_resize_origin.as_str(), "right" | "left") {
        settings.width_resize_origin = defaults.width_resize_origin;
    }
    if !matches!(settings.capture_interval_min, 1 | 5 | 15 | 30 | 60 | 240) {
        settings.capture_interval_min = defaults.capture_interval_min;
    }
    settings.capture_file_name =
        sanitize_file_name(&settings.capture_file_name).unwrap_or(defaults.capture_file_name);
    if !Path::new(&settings.capture_directory).is_dir() {
        settings.capture_directory = defaults.capture_directory;
    }
    if !settings.wide_mode_width.is_finite()
        || !settings.narrow_mode_width.is_finite()
        || settings.narrow_mode_width < MIN_WINDOW_WIDTH
        || settings.wide_mode_width <= settings.narrow_mode_width
    {
        settings.wide_mode_width = defaults.wide_mode_width;
        settings.narrow_mode_width = defaults.narrow_mode_width;
    }
    if !settings.window_width.is_finite() || settings.window_width < MIN_WINDOW_WIDTH {
        settings.window_width = defaults.window_width;
    }
    if !settings.window_height.is_finite() || settings.window_height < MIN_WINDOW_HEIGHT {
        settings.window_height = defaults.window_height;
    }
    settings.window_x = sanitize_window_coordinate(settings.window_x);
    settings.window_y = sanitize_window_coordinate(settings.window_y);
    settings
}

fn prepare_settings_update(
    global: &AppSettings,
    local: &AppSettings,
    patch: SettingsPatch,
) -> Result<(AppSettings, AppSettings), String> {
    let mut next_global = global.clone();
    let mut next_local = local.clone();

    if let Some(theme) = patch.theme {
        if !matches!(theme.as_str(), "dark" | "light") {
            return Err(String::from("Theme must be dark or light"));
        }
        next_global.theme = theme;
    }

    if let Some(site_url) = patch.site_url {
        if site_url.len() > 64 || !is_https_url(&site_url) {
            return Err(String::from("Site URL must be a valid https:// URL"));
        }
        next_global.site_url = site_url;
    }

    if let Some(interval) = patch.capture_interval_min {
        if !matches!(interval, 1 | 5 | 15 | 30 | 60 | 240) {
            return Err(String::from("Capture interval is invalid"));
        }
        next_global.capture_interval_min = interval;
    }

    if let Some(file_name) = patch.capture_file_name {
        next_global.capture_file_name = sanitize_file_name(&file_name)
            .ok_or_else(|| String::from("Capture file name is invalid"))?;
    }

    if let Some(directory) = patch.capture_directory {
        if !Path::new(&directory).is_dir() {
            return Err(String::from(
                "Download destination must be an existing directory",
            ));
        }
        next_global.capture_directory = directory;
    }

    if patch.wide_mode_width.is_some() || patch.narrow_mode_width.is_some() {
        let wide = patch.wide_mode_width.unwrap_or(next_global.wide_mode_width);
        let narrow = patch
            .narrow_mode_width
            .unwrap_or(next_global.narrow_mode_width);
        if !wide.is_finite() || !narrow.is_finite() || narrow < MIN_WINDOW_WIDTH || wide <= narrow {
            return Err(String::from(
                "Display widths must be finite, at least 320px, and wide must exceed narrow",
            ));
        }
        next_global.wide_mode_width = wide.round();
        next_global.narrow_mode_width = narrow.round();
    }

    if let Some(always_on_top) = patch.always_on_top {
        next_global.always_on_top = always_on_top;
        next_local.always_on_top = always_on_top;
    }

    if let Some(origin) = patch.width_resize_origin {
        if !matches!(origin.as_str(), "right" | "left") {
            return Err(String::from("Width resize origin must be right or left"));
        }
        next_global.width_resize_origin = origin.clone();
        next_local.width_resize_origin = origin;
    }

    Ok((next_global, next_local))
}

fn prepare_validated_settings_update(
    global: &AppSettings,
    local: &AppSettings,
    patch: SettingsPatch,
) -> Result<(AppSettings, AppSettings), String> {
    let validate_destination =
        patch.capture_directory.is_some() || patch.capture_file_name.is_some();
    let result = prepare_settings_update(global, local, patch)?;
    if validate_destination {
        validate_capture_destination(&result.0)?;
    }
    Ok(result)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|dir| dir.join(SETTINGS_FILE_NAME))
        .map_err(|error| error.to_string())
}

fn legacy_settings_path() -> Option<PathBuf> {
    std::env::var("HOME").ok().map(|home| {
        Path::new(&home)
            .join("Library/Application Support/tv-browser")
            .join(SETTINGS_FILE_NAME)
    })
}

fn invalid_settings_backup_path(path: &Path) -> Result<PathBuf, String> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| format!("System clock is before the Unix epoch: {error}"))?
        .as_millis();
    let parent = path
        .parent()
        .ok_or_else(|| String::from("Settings file has no parent directory"))?;

    for attempt in 0..1_000 {
        let suffix = if attempt == 0 {
            String::new()
        } else {
            format!("-{attempt}")
        };
        let candidate = parent.join(format!("settings.invalid-{timestamp}{suffix}.json"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }

    Err(String::from(
        "Could not allocate a unique invalid settings backup path",
    ))
}

fn recover_invalid_settings(path: &Path, reason: &str) -> Result<SettingsLoadResult, String> {
    let backup = invalid_settings_backup_path(path)?;
    fs::rename(path, &backup).map_err(|error| {
        format!(
            "Settings could not be loaded ({reason}) and the invalid file could not be preserved: {error}"
        )
    })?;

    Ok(SettingsLoadResult {
        settings: AppSettings::default(),
        warning: Some(format!(
            "Settings could not be loaded, so default settings are being used.\n\nReason: {reason}\nThe original file was preserved at:\n{}",
            backup.display()
        )),
    })
}

fn load_settings_from_source(source: Option<PathBuf>) -> Result<SettingsLoadResult, String> {
    let Some(path) = source else {
        return Ok(SettingsLoadResult {
            settings: AppSettings::default(),
            warning: None,
        });
    };

    let json = match fs::read_to_string(&path) {
        Ok(json) => json,
        Err(error) => {
            return recover_invalid_settings(&path, &format!("File read failed: {error}"));
        }
    };
    let settings = match serde_json::from_str::<AppSettings>(&json) {
        Ok(settings) => settings,
        Err(error) => {
            return recover_invalid_settings(&path, &format!("JSON is invalid: {error}"));
        }
    };

    Ok(SettingsLoadResult {
        settings: sanitize_settings(settings),
        warning: None,
    })
}

fn load_settings(app: &tauri::AppHandle) -> Result<SettingsLoadResult, String> {
    let primary = settings_path(app)?;
    let source = primary
        .is_file()
        .then_some(primary)
        .or_else(|| legacy_settings_path().filter(|path| path.is_file()));

    load_settings_from_source(source)
}

fn save_settings(app: &tauri::AppHandle, settings: &AppSettings) -> Result<(), String> {
    let path = settings_path(app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let json = serde_json::to_string_pretty(&sanitize_settings(settings.clone()))
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, json).map_err(|error| error.to_string())?;
    fs::rename(temporary, path).map_err(|error| error.to_string())
}

fn compose_settings(global: &AppSettings, local: &AppSettings) -> AppSettings {
    AppSettings {
        theme: global.theme.clone(),
        always_on_top: local.always_on_top,
        site_url: global.site_url.clone(),
        card_width: local.card_width,
        card_height: local.card_height,
        window_width: local.window_width,
        window_height: local.window_height,
        window_x: local.window_x,
        window_y: local.window_y,
        width_resize_origin: local.width_resize_origin.clone(),
        capture_interval_min: global.capture_interval_min,
        capture_file_name: global.capture_file_name.clone(),
        capture_directory: global.capture_directory.clone(),
        wide_mode_width: global.wide_mode_width,
        narrow_mode_width: global.narrow_mode_width,
    }
}

fn window_snapshot_candidate(
    global: &AppSettings,
    local: &AppSettings,
    snapshot: WindowSnapshot,
) -> (AppSettings, AppSettings) {
    let mut next_local = local.clone();
    next_local.window_width = snapshot.width;
    next_local.window_height = snapshot.height;
    next_local.window_x = Some(snapshot.x);
    next_local.window_y = Some(snapshot.y);

    let mut next_global = global.clone();
    next_global.always_on_top = next_local.always_on_top;
    next_global.window_width = next_local.window_width;
    next_global.window_height = next_local.window_height;
    next_global.window_x = next_local.window_x;
    next_global.window_y = next_local.window_y;
    next_global.width_resize_origin = next_local.width_resize_origin.clone();
    (next_global, next_local)
}

fn save_then_commit_settings<F>(
    current_global: &mut AppSettings,
    current_local: &mut AppSettings,
    next_global: AppSettings,
    next_local: AppSettings,
    save: F,
) -> Result<(), String>
where
    F: FnOnce(&AppSettings) -> Result<(), String>,
{
    save(&next_global)?;
    *current_global = next_global;
    *current_local = next_local;
    Ok(())
}

fn read_window_snapshot(window: &WebviewWindow) -> Result<WindowSnapshot, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let size = window
        .inner_size()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let position = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    Ok(WindowSnapshot {
        width: size.width,
        height: size.height,
        x: position.x,
        y: position.y,
    })
}

fn compute_layout(window_width: f64, window_height: f64, wide_mode_width: f64) -> LayoutMetrics {
    let available_width = (window_width - WINDOW_PADDING * 2.0).max(1.0);
    let card_width = available_width.max((wide_mode_width - WINDOW_PADDING * 2.0).max(336.0));
    let card_height = (window_height - HEADER_HEIGHT - WINDOW_PADDING * 2.0).max(1.0);
    let card_x = window_width - WINDOW_PADDING - card_width;
    let card_y = HEADER_HEIGHT + WINDOW_PADDING;
    LayoutMetrics {
        header_height: HEADER_HEIGHT,
        card_x,
        card_y,
        card_width,
        card_height,
        content_x: card_x + CARD_PADDING,
        content_y: card_y + CARD_PADDING,
        content_width: (card_width - CARD_PADDING * 2.0).max(1.0),
        content_height: (card_height - CARD_PADDING * 2.0).max(1.0),
        card_padding: CARD_PADDING,
    }
}

fn child_webview_bounds(
    layout: &LayoutMetrics,
    scale: f64,
    titlebar_height: f64,
) -> (PhysicalPosition<i32>, PhysicalSize<u32>) {
    (
        PhysicalPosition::new(
            (layout.content_x * scale).round() as i32,
            ((layout.content_y + titlebar_height) * scale).round() as i32,
        ),
        PhysicalSize::new(
            (layout.content_width * scale).round().max(1.0) as u32,
            ((layout.content_height - titlebar_height).max(1.0) * scale)
                .round()
                .max(1.0) as u32,
        ),
    )
}

fn window_logical_size(window: &WebviewWindow) -> Result<(f64, f64), String> {
    let size = window.inner_size().map_err(|error| error.to_string())?;
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let logical = size.to_logical::<f64>(scale);
    Ok((logical.width, logical.height))
}

fn titlebar_height(window: &WebviewWindow) -> Result<f64, String> {
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let outer = window
        .outer_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let inner = window
        .inner_position()
        .map_err(|error| error.to_string())?
        .to_logical::<f64>(scale);
    let measured = (inner.y - outer.y).max(0.0);
    Ok(if measured > 0.0 {
        measured
    } else {
        MACOS_TITLEBAR_HEIGHT
    })
}

fn apply_layout(app: &tauri::AppHandle, label: &str) -> Result<LayoutMetrics, String> {
    let state = app.state::<AppState>();
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| String::from("State lock failed"))?;
    let wide = runtime.settings.wide_mode_width;
    let context = runtime
        .windows
        .get_mut(label)
        .ok_or_else(|| String::from("Window context not found"))?;
    let (width, height) = window_logical_size(&context.window)?;
    let scale = context
        .window
        .scale_factor()
        .map_err(|error| error.to_string())?;
    let titlebar = titlebar_height(&context.window)?;
    let layout = compute_layout(width, height, wide);
    let (content_position, content_size) = child_webview_bounds(&layout, scale, titlebar);
    context.latest_layout = layout.clone();

    if context.suspended {
        context
            .trading_view
            .hide()
            .map_err(|error| error.to_string())?;
    } else {
        context
            .trading_view
            .show()
            .map_err(|error| error.to_string())?;
        context
            .trading_view
            .set_position(Position::Physical(content_position))
            .map_err(|error| error.to_string())?;
        context
            .trading_view
            .set_size(Size::Physical(content_size))
            .map_err(|error| error.to_string())?;
    }
    drop(runtime);
    let _ = app.emit_to(label, "layout-changed", &layout);
    Ok(layout)
}

fn persist_window_snapshot(app: &tauri::AppHandle, label: &str) -> Result<AppSettings, String> {
    persist_window_snapshot_with_origin(app, label, None)
}

fn persist_window_snapshot_with_origin(
    app: &tauri::AppHandle,
    label: &str,
    width_resize_origin: Option<&str>,
) -> Result<AppSettings, String> {
    let state = app.state::<AppState>();
    let window = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        runtime
            .windows
            .get(label)
            .map(|context| context.window.clone())
            .ok_or_else(|| String::from("Window context not found"))?
    };
    let snapshot = read_window_snapshot(&window)?;

    let mut runtime = state
        .0
        .lock()
        .map_err(|_| String::from("State lock failed"))?;
    let previous_local = runtime
        .windows
        .get(label)
        .map(|context| context.local.clone())
        .ok_or_else(|| String::from("Window context not found"))?;
    let (mut next_global, mut next_local) =
        window_snapshot_candidate(&runtime.settings, &previous_local, snapshot);
    if let Some(origin) = width_resize_origin {
        let origin = if origin == "left" { "left" } else { "right" };
        next_local.width_resize_origin = origin.to_string();
        next_global.width_resize_origin = origin.to_string();
    }
    let RuntimeState {
        settings, windows, ..
    } = &mut *runtime;
    let current_local = &mut windows
        .get_mut(label)
        .ok_or_else(|| String::from("Window context not found"))?
        .local;
    save_then_commit_settings(
        settings,
        current_local,
        next_global,
        next_local,
        |candidate| save_settings(app, candidate),
    )?;
    Ok(compose_settings(settings, current_local))
}

fn report_settings_save_error(app: &tauri::AppHandle, label: &str, error: String) {
    eprintln!("Failed to save window settings for {label}: {error}");
    let _ = app.emit_to(label, "settings-save-error", error);
}

fn window_persistence_is_suppressed(app: &tauri::AppHandle, label: &str) -> bool {
    app.state::<AppState>()
        .0
        .lock()
        .map(|runtime| runtime.window_persistence_suppressed.contains(label))
        .unwrap_or(true)
}

fn set_window_persistence_suppressed(
    app: &tauri::AppHandle,
    label: &str,
    suppressed: bool,
) -> Result<(), String> {
    let state = app.state::<AppState>();
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| String::from("State lock failed"))?;
    if suppressed {
        runtime
            .window_persistence_suppressed
            .insert(label.to_string());
    } else {
        runtime.window_persistence_suppressed.remove(label);
    }
    Ok(())
}

fn capture_state(runtime: &RuntimeState) -> CaptureState {
    CaptureState {
        active_window_label: runtime.active_capture_label.clone(),
        paused: runtime.capture_paused,
    }
}

fn emit_capture_state(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let (labels, payload) = {
        let Ok(runtime) = state.0.lock() else {
            return;
        };
        (
            runtime.windows.keys().cloned().collect::<Vec<_>>(),
            capture_state(&runtime),
        )
    };
    for label in labels {
        let _ = app.emit_to(label, "capture-state-changed", &payload);
    }
}

fn next_capture_delay(now: SystemTime, interval_min: u32) -> Duration {
    let elapsed = now.duration_since(UNIX_EPOCH).unwrap_or_default();
    let now_ms = elapsed.as_millis();
    let local_ms = now_ms + JST_OFFSET_SECONDS * 1_000;
    let interval_ms = u128::from(interval_min) * 60 * 1_000;
    let next_boundary_ms = (local_ms / interval_ms + 1) * interval_ms;
    let target_ms = next_boundary_ms + CAPTURE_MARGIN_SECONDS * 1_000;
    Duration::from_millis((target_ms - local_ms).min(u128::from(u64::MAX)) as u64)
}

fn restart_capture_scheduler(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    let mut runtime = match state.0.lock() {
        Ok(runtime) => runtime,
        Err(_) => return,
    };

    if let Some(task) = runtime.capture_task.take() {
        task.abort();
    }

    let Some(label) = runtime.active_capture_label.clone() else {
        return;
    };
    if runtime.capture_paused {
        return;
    }

    let app_for_task = app.clone();
    runtime.capture_task = Some(tauri::async_runtime::spawn(async move {
        loop {
            let delay = {
                let state = app_for_task.state::<AppState>();
                let Ok(runtime) = state.0.lock() else {
                    return;
                };
                if runtime.active_capture_label.as_deref() != Some(&label) || runtime.capture_paused
                {
                    return;
                }
                next_capture_delay(SystemTime::now(), runtime.settings.capture_interval_min)
            };

            tokio::time::sleep(delay).await;

            if let Err(error) = capture_for_label(&app_for_task, &label).await {
                let still_active = {
                    let state = app_for_task.state::<AppState>();
                    state
                        .0
                        .lock()
                        .map(|runtime| {
                            runtime.active_capture_label.as_deref() == Some(&label)
                                && !runtime.capture_paused
                        })
                        .unwrap_or(false)
                };
                if !still_active {
                    return;
                }
                eprintln!("Periodic capture failed for {label}: {error}");
                let _ = app_for_task.emit_to(&label, "capture-error", error);
            }
        }
    }));
}

fn prepare_exit_request(app: &tauri::AppHandle) -> ExitRequestAction {
    let state = app.state::<AppState>();
    let Ok(mut runtime) = state.0.lock() else {
        return ExitRequestAction::Allow;
    };
    let action = exit_request_action(
        runtime.active_capture_label.is_some(),
        runtime.exit_confirmation_open,
    );
    if action == ExitRequestAction::Prompt {
        runtime.exit_confirmation_open = true;
    }
    action
}

fn emit_exit_confirmation(app: &tauri::AppHandle) {
    let active_label = {
        let state = app.state::<AppState>();
        let Ok(runtime) = state.0.lock() else {
            return;
        };
        runtime.active_capture_label.clone()
    };
    let Some(active_label) = active_label else {
        return;
    };

    if app
        .emit_to(&active_label, "app-exit-requested", ())
        .is_err()
    {
        let state = app.state::<AppState>();
        if let Ok(mut runtime) = state.0.lock() {
            runtime.exit_confirmation_open = false;
        }
    }
}

fn request_exit_from_menu(app: &tauri::AppHandle) {
    match prepare_exit_request(app) {
        ExitRequestAction::Allow => app.exit(0),
        ExitRequestAction::Prevent => {}
        ExitRequestAction::Prompt => emit_exit_confirmation(app),
    }
}

fn handle_exit_requested(app: &tauri::AppHandle, api: &tauri::ExitRequestApi) {
    match prepare_exit_request(app) {
        ExitRequestAction::Allow => {}
        ExitRequestAction::Prevent => api.prevent_exit(),
        ExitRequestAction::Prompt => {
            api.prevent_exit();
            emit_exit_confirmation(app);
        }
    }
}

fn create_app_window(
    app: &tauri::AppHandle,
    source_label: Option<&str>,
) -> Result<WebviewWindow, String> {
    let state = app.state::<AppState>();
    let (label, local, site_url, source_position) = {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        runtime.next_window_id += 1;
        let label = format!("main-{}", runtime.next_window_id);
        let local = source_label
            .and_then(|source| {
                runtime
                    .windows
                    .get(source)
                    .map(|context| context.local.clone())
            })
            .unwrap_or_else(|| runtime.settings.clone());
        let source_position = source_label.and_then(|source| {
            runtime
                .windows
                .get(source)
                .and_then(|context| context.window.outer_position().ok())
                .and_then(|position| {
                    context_scale(&runtime, source).map(|scale| position.to_logical::<f64>(scale))
                })
        });
        (
            label,
            local,
            runtime.settings.site_url.clone(),
            source_position,
        )
    };

    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::App("index.html".into()))
        .title("TV Browser")
        .inner_size(local.window_width, local.window_height)
        .min_inner_size(MIN_WINDOW_WIDTH, MIN_WINDOW_HEIGHT)
        .accept_first_mouse(true)
        .always_on_top(local.always_on_top);

    let has_requested_position =
        source_position.is_some() || matches!((local.window_x, local.window_y), (Some(_), Some(_)));
    if let Some(position) = source_position {
        builder = builder.position(
            position.x + NEW_WINDOW_OFFSET,
            position.y + NEW_WINDOW_OFFSET,
        );
    } else if let (Some(x), Some(y)) = (local.window_x, local.window_y) {
        builder = builder.position(x, y);
    }

    let window = builder.build().map_err(|error| error.to_string())?;
    let position_was_adjusted = if has_requested_position {
        constrain_window_to_work_area(app, &window)?
    } else {
        false
    };
    let parent = window.as_ref().window();
    let remote_label = format!("{label}-tradingview");
    let remote_slot: Arc<Mutex<Option<Webview>>> = Arc::new(Mutex::new(None));
    let remote_for_popup = Arc::clone(&remote_slot);
    let url = site_url
        .parse::<tauri::Url>()
        .map_err(|error| error.to_string())?;

    let webview_builder = WebviewBuilder::new(&remote_label, WebviewUrl::External(url))
        .data_store_identifier(TRADINGVIEW_DATA_STORE_ID)
        .accept_first_mouse(true)
        .on_navigation(|url| url.scheme() == "https")
        .on_new_window(move |url, _features| {
            if url.scheme() == "https" {
                if let Ok(slot) = remote_for_popup.lock() {
                    if let Some(webview) = slot.as_ref() {
                        let _ = webview.navigate(url);
                    }
                }
            }
            tauri::webview::NewWindowResponse::Deny
        });

    let initial_layout = compute_layout(local.window_width, local.window_height, {
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        runtime.settings.wide_mode_width
    });
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let titlebar = titlebar_height(&window)?;
    let (initial_position, initial_size) = child_webview_bounds(&initial_layout, scale, titlebar);
    let trading_view = parent
        .add_child(webview_builder, initial_position, initial_size)
        .map_err(|error| error.to_string())?;
    if let Ok(mut slot) = remote_slot.lock() {
        *slot = Some(trading_view.clone());
    }

    {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        runtime.windows.insert(
            label.clone(),
            WindowContext {
                window: window.clone(),
                trading_view,
                local,
                suspended: false,
                latest_layout: initial_layout,
            },
        );
    }

    let app_for_events = app.clone();
    let label_for_events = label.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Resized(_) => {
            let _ = apply_layout(&app_for_events, &label_for_events);
            if !window_persistence_is_suppressed(&app_for_events, &label_for_events)
                && let Err(error) = persist_window_snapshot(&app_for_events, &label_for_events)
            {
                report_settings_save_error(&app_for_events, &label_for_events, error);
            }
        }
        WindowEvent::Moved(_) => {
            if !window_persistence_is_suppressed(&app_for_events, &label_for_events)
                && let Err(error) = persist_window_snapshot(&app_for_events, &label_for_events)
            {
                report_settings_save_error(&app_for_events, &label_for_events, error);
            }
        }
        WindowEvent::Destroyed => {
            let state = app_for_events.state::<AppState>();
            let capture_task = if let Ok(mut runtime) = state.0.lock() {
                runtime.windows.remove(&label_for_events);
                runtime
                    .window_persistence_suppressed
                    .remove(&label_for_events);
                if runtime.active_capture_label.as_deref() == Some(&label_for_events) {
                    runtime.active_capture_label = None;
                    runtime.capture_paused = false;
                    runtime.capture_task.take()
                } else {
                    None
                }
            } else {
                None
            };
            if let Some(task) = capture_task {
                task.abort();
            }
            emit_capture_state(&app_for_events);
        }
        _ => {}
    });

    let _ = apply_layout(app, &label);
    if position_was_adjusted && let Err(error) = persist_window_snapshot(app, &label) {
        report_settings_save_error(app, &label, error);
    }
    Ok(window)
}

fn context_scale(runtime: &RuntimeState, label: &str) -> Option<f64> {
    runtime
        .windows
        .get(label)
        .and_then(|context| context.window.scale_factor().ok())
}

#[tauri::command]
fn get_settings(
    webview: Webview,
    state: tauri::State<'_, AppState>,
) -> Result<AppSettings, String> {
    let runtime = state
        .0
        .lock()
        .map_err(|_| String::from("State lock failed"))?;
    let context = runtime
        .windows
        .get(webview.label())
        .ok_or_else(|| String::from("Window context not found"))?;
    Ok(compose_settings(&runtime.settings, &context.local))
}

#[tauri::command]
fn take_startup_warning(state: tauri::State<'_, AppState>) -> Result<Option<String>, String> {
    let mut runtime = state
        .0
        .lock()
        .map_err(|_| String::from("State lock failed"))?;
    Ok(runtime.startup_warning.take())
}

#[tauri::command]
fn update_settings(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<AppSettings, String> {
    let label = webview.label().to_string();
    let (result, labels, site_changed, layout_changed, capture_schedule_changed) = {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        let previous_site = runtime.settings.site_url.clone();
        let previous_wide = runtime.settings.wide_mode_width;
        let previous_capture_interval = runtime.settings.capture_interval_min;
        let context = runtime
            .windows
            .get(&label)
            .ok_or_else(|| String::from("Window context not found"))?;
        let previous_local = context.local.clone();
        let window = context.window.clone();
        let (next_global, next_local) =
            prepare_validated_settings_update(&runtime.settings, &previous_local, patch)?;
        let always_on_top_changed = next_local.always_on_top != previous_local.always_on_top;

        if always_on_top_changed {
            window
                .set_always_on_top(next_local.always_on_top)
                .map_err(|error| error.to_string())?;
        }

        let commit_result = {
            let RuntimeState {
                settings, windows, ..
            } = &mut *runtime;
            let current_local = &mut windows
                .get_mut(&label)
                .ok_or_else(|| String::from("Window context not found"))?
                .local;
            save_then_commit_settings(
                settings,
                current_local,
                next_global,
                next_local,
                |candidate| save_settings(&app, candidate),
            )
        };
        if let Err(save_error) = commit_result {
            if always_on_top_changed
                && let Err(rollback_error) = window.set_always_on_top(previous_local.always_on_top)
            {
                return Err(format!(
                    "{save_error}; failed to restore Always on Top: {rollback_error}"
                ));
            }
            return Err(save_error);
        }

        let committed_local = runtime
            .windows
            .get(&label)
            .ok_or_else(|| String::from("Window context not found"))?
            .local
            .clone();
        let result = compose_settings(&runtime.settings, &committed_local);
        let labels = runtime.windows.keys().cloned().collect::<Vec<_>>();
        (
            result,
            labels,
            runtime.settings.site_url != previous_site,
            runtime.settings.wide_mode_width != previous_wide,
            runtime.settings.capture_interval_min != previous_capture_interval,
        )
    };

    if capture_schedule_changed {
        restart_capture_scheduler(&app);
    }
    if site_changed {
        let url = result
            .site_url
            .parse::<tauri::Url>()
            .map_err(|error| error.to_string())?;
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        for context in runtime.windows.values() {
            let _ = context.trading_view.navigate(url.clone());
        }
    }
    if layout_changed {
        for current_label in &labels {
            let _ = apply_layout(&app, current_label);
        }
    }
    for current_label in labels {
        let settings = {
            let runtime = state
                .0
                .lock()
                .map_err(|_| String::from("State lock failed"))?;
            runtime
                .windows
                .get(&current_label)
                .map(|context| compose_settings(&runtime.settings, &context.local))
        };
        if let Some(settings) = settings {
            let _ = app.emit_to(&current_label, "settings-changed", settings);
        }
    }
    Ok(result)
}

#[tauri::command]
fn get_layout(app: tauri::AppHandle, webview: Webview) -> Result<LayoutMetrics, String> {
    apply_layout(&app, webview.label())
}

#[tauri::command]
fn set_trading_view_suspended(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
    suspended: bool,
) -> Result<(), String> {
    let label = webview.label().to_string();
    {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        let context = runtime
            .windows
            .get_mut(&label)
            .ok_or_else(|| String::from("Window context not found"))?;
        context.suspended = suspended;
        if runtime.active_capture_label.as_deref() == Some(&label) {
            runtime.capture_paused = suspended;
        }
    }
    restart_capture_scheduler(&app);
    apply_layout(&app, &label)?;
    emit_capture_state(&app);
    Ok(())
}

#[tauri::command]
fn set_window_width(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
    width: f64,
    origin: String,
) -> Result<AppSettings, String> {
    let label = webview.label().to_string();
    let window = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        runtime
            .windows
            .get(&label)
            .map(|context| context.window.clone())
            .ok_or_else(|| String::from("Window context not found"))?
    };
    let target = width.round().max(MIN_WINDOW_WIDTH);
    let scale = window.scale_factor().map_err(|error| error.to_string())?;
    let previous_physical_size = window.inner_size().map_err(|error| error.to_string())?;
    let previous_physical_position = window.outer_position().map_err(|error| error.to_string())?;
    let current_size = previous_physical_size.to_logical::<f64>(scale);
    let current_position = previous_physical_position.to_logical::<f64>(scale);

    set_window_persistence_suppressed(&app, &label, true)?;
    let operation = (|| -> Result<AppSettings, String> {
        window
            .set_size(Size::Logical(LogicalSize::new(target, current_size.height)))
            .map_err(|error| error.to_string())?;
        if origin == "left" {
            window
                .set_position(Position::Logical(LogicalPosition::new(
                    current_position.x + current_size.width - target,
                    current_position.y,
                )))
                .map_err(|error| error.to_string())?;
        }
        let _ = apply_layout(&app, &label);
        persist_window_snapshot_with_origin(&app, &label, Some(&origin))
    })();

    let result = match operation {
        Ok(settings) => Ok(settings),
        Err(error) => {
            let size_rollback = window
                .set_size(Size::Physical(previous_physical_size))
                .map_err(|rollback| rollback.to_string());
            let position_rollback = window
                .set_position(Position::Physical(previous_physical_position))
                .map_err(|rollback| rollback.to_string());
            let _ = apply_layout(&app, &label);
            match (size_rollback, position_rollback) {
                (Ok(()), Ok(())) => Err(error),
                (size, position) => Err(format!(
                    "{error}; failed to restore window geometry: size={size:?}, position={position:?}"
                )),
            }
        }
    };
    let suppression_result = set_window_persistence_suppressed(&app, &label, false);
    match (result, suppression_result) {
        (Ok(settings), Ok(())) => Ok(settings),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(error)) => Err(error),
        (Err(error), Err(suppression_error)) => Err(format!("{error}; {suppression_error}")),
    }
}

#[tauri::command]
fn create_window(app: tauri::AppHandle, webview: Webview) -> Result<(), String> {
    create_app_window(&app, Some(webview.label())).map(|_| ())
}

#[tauri::command]
fn get_capture_state(state: tauri::State<'_, AppState>) -> Result<CaptureState, String> {
    let runtime = state
        .0
        .lock()
        .map_err(|_| String::from("State lock failed"))?;
    Ok(capture_state(&runtime))
}

#[tauri::command]
fn toggle_periodic_capture(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
) -> Result<CaptureToggleResult, String> {
    let label = webview.label().to_string();
    let settings_to_validate = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        runtime
            .active_capture_label
            .is_none()
            .then(|| runtime.settings.clone())
    };
    if let Some(settings) = settings_to_validate {
        validate_capture_destination(&settings)?;
    }

    let result = {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        match runtime.active_capture_label.as_deref() {
            None => {
                runtime.active_capture_label = Some(label.clone());
                runtime.capture_paused = runtime
                    .windows
                    .get(&label)
                    .map(|context| context.suspended)
                    .unwrap_or(false);
                CaptureToggleResult {
                    status: String::from("started"),
                    reason: None,
                }
            }
            Some(active) if active == label => {
                runtime.active_capture_label = None;
                runtime.capture_paused = false;
                CaptureToggleResult {
                    status: String::from("stopped"),
                    reason: None,
                }
            }
            Some(_) => CaptureToggleResult {
                status: String::from("blocked"),
                reason: Some(String::from("another-window")),
            },
        }
    };
    restart_capture_scheduler(&app);
    emit_capture_state(&app);
    Ok(result)
}

#[tauri::command]
fn resolve_app_exit(
    app: tauri::AppHandle,
    webview: Webview,
    state: tauri::State<'_, AppState>,
    should_quit: bool,
) -> Result<(), String> {
    let should_exit = {
        let mut runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        if !runtime.exit_confirmation_open {
            return Ok(());
        }
        if runtime.active_capture_label.as_deref() != Some(webview.label()) {
            return Err(String::from(
                "Only the active capture window can resolve an exit request",
            ));
        }

        runtime.exit_confirmation_open = false;
        if should_quit {
            runtime.active_capture_label = None;
            runtime.capture_paused = false;
        }
        should_quit
    };

    if should_exit {
        emit_capture_state(&app);
        app.exit(0);
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn snapshot_png(webview: &Webview) -> Result<Vec<u8>, String> {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;

    let (sender, receiver) = std::sync::mpsc::sync_channel::<Result<Vec<u8>, String>>(1);
    webview
        .with_webview(move |platform_webview| unsafe {
            let wk_webview = &*(platform_webview.inner() as *const WKWebView);
            let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                let result = if !error.is_null() {
                    Err(format!("WKWebView snapshot failed: {:?}", &*error))
                } else if image.is_null() {
                    Err(String::from("WKWebView returned an empty snapshot"))
                } else {
                    let image = &*image;
                    image
                        .TIFFRepresentation()
                        .ok_or_else(|| String::from("Failed to encode snapshot as TIFF"))
                        .and_then(|tiff| {
                            NSBitmapImageRep::imageRepWithData(&tiff)
                                .ok_or_else(|| String::from("Failed to create bitmap"))
                        })
                        .and_then(|bitmap| {
                            let properties =
                                NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                            bitmap
                                .representationUsingType_properties(
                                    NSBitmapImageFileType::PNG,
                                    &properties,
                                )
                                .ok_or_else(|| String::from("Failed to encode snapshot as PNG"))
                        })
                        .map(|png| png.to_vec())
                };
                let _ = sender.send(result);
            });
            wk_webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(30))
        .map_err(|_| String::from("Timed out while capturing TradingView"))?
}

#[cfg(not(target_os = "macos"))]
fn snapshot_png(_webview: &Webview) -> Result<Vec<u8>, String> {
    Err(String::from(
        "Periodic capture is currently supported on macOS only",
    ))
}

async fn capture_for_label(app: &tauri::AppHandle, label: &str) -> Result<String, String> {
    let state = app.state::<AppState>();
    let (webview, path) = {
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        if runtime.active_capture_label.as_deref() != Some(label) {
            return Err(String::from(
                "Periodic capture is not active for this window",
            ));
        }
        if runtime.capture_paused {
            return Err(String::from("Periodic capture is paused"));
        }
        let context = runtime
            .windows
            .get(label)
            .ok_or_else(|| String::from("Window context not found"))?;
        (
            context.trading_view.clone(),
            capture_output_path(&runtime.settings),
        )
    };

    let png = tauri::async_runtime::spawn_blocking(move || snapshot_png(&webview))
        .await
        .map_err(|error| error.to_string())??;

    {
        let runtime = state
            .0
            .lock()
            .map_err(|_| String::from("State lock failed"))?;
        if runtime.active_capture_label.as_deref() != Some(label) || runtime.capture_paused {
            return Err(String::from(
                "Periodic capture stopped before the snapshot was saved",
            ));
        }
    }

    write_capture_output(&path, &png)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn capture_now(app: tauri::AppHandle, webview: Webview) -> Result<String, String> {
    capture_for_label(&app, webview.label()).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .menu(|app| {
            let new_window = MenuItemBuilder::with_id("new-window", "New Window")
                .accelerator("CmdOrCtrl+N")
                .build(app)?;
            let quit = MenuItemBuilder::with_id("quit", "Quit TV Browser")
                .accelerator("CmdOrCtrl+Q")
                .build(app)?;
            let app_menu = SubmenuBuilder::new(app, "TV Browser")
                .about(None)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .separator()
                .item(&quit)
                .build()?;
            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&new_window)
                .separator()
                .close_window()
                .build()?;
            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .undo()
                .redo()
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;
            MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu])
                .build()
        })
        .on_menu_event(|app, event| match event.id().as_ref() {
            "new-window" => {
                let source = app
                    .webview_windows()
                    .into_values()
                    .find(|window| window.is_focused().unwrap_or(false))
                    .map(|window| window.label().to_string());
                let _ = create_app_window(app, source.as_deref());
            }
            "quit" => request_exit_from_menu(app),
            _ => {}
        })
        .setup(|app| {
            let loaded = load_settings(app.handle()).map_err(std::io::Error::other)?;
            app.manage(AppState(Mutex::new(RuntimeState {
                settings: loaded.settings,
                startup_warning: loaded.warning,
                windows: HashMap::new(),
                next_window_id: 0,
                active_capture_label: None,
                capture_paused: false,
                capture_task: None,
                exit_confirmation_open: false,
                window_persistence_suppressed: HashSet::new(),
            })));
            create_app_window(app.handle(), None).map_err(std::io::Error::other)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_settings,
            take_startup_warning,
            update_settings,
            get_layout,
            set_trading_view_suspended,
            set_window_width,
            create_window,
            get_capture_state,
            toggle_periodic_capture,
            resolve_app_exit,
            capture_now
        ])
        .build(tauri::generate_context!())
        .expect("error while building TV Browser");

    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = event {
            handle_exit_requested(app, &api);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{
        AppSettings, ExitRequestAction, SettingsPatch, WindowSnapshot, WorkArea,
        child_webview_bounds, clamp_window_position, compute_layout, exit_request_action,
        load_settings_from_source, next_capture_delay, prepare_settings_update,
        prepare_validated_settings_update, sanitize_window_coordinate, save_then_commit_settings,
        validate_capture_destination, window_snapshot_candidate, write_capture_output,
    };
    use std::{
        fs,
        path::PathBuf,
        time::{Duration, SystemTime, UNIX_EPOCH},
    };
    use tauri::{PhysicalPosition, PhysicalSize};

    #[cfg(unix)]
    use std::os::unix::fs::{PermissionsExt, symlink};

    fn test_settings() -> AppSettings {
        AppSettings {
            capture_directory: std::env::temp_dir().to_string_lossy().into_owned(),
            ..AppSettings::default()
        }
    }

    fn create_test_directory(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system time after Unix epoch")
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("tv-browser-{name}-{}-{unique}", std::process::id()));
        fs::create_dir(&directory).expect("create test directory");
        directory
    }

    #[test]
    fn missing_settings_file_uses_defaults_without_warning() {
        let loaded = load_settings_from_source(None).expect("load default settings");

        assert_eq!(loaded.settings, AppSettings::default());
        assert_eq!(loaded.warning, None);
    }

    #[test]
    fn valid_settings_file_is_loaded_without_warning() {
        let directory = create_test_directory("valid-settings");
        let path = directory.join("settings.json");
        let mut expected = test_settings();
        expected.theme = String::from("light");
        fs::write(
            &path,
            serde_json::to_string_pretty(&expected).expect("serialize settings"),
        )
        .expect("write settings");

        let loaded =
            load_settings_from_source(Some(path.clone())).expect("load valid settings file");

        assert_eq!(loaded.settings, expected);
        assert_eq!(loaded.warning, None);
        assert!(path.is_file());
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn missing_settings_fields_are_filled_from_defaults() {
        let directory = create_test_directory("partial-settings");
        let path = directory.join("settings.json");
        fs::write(&path, r#"{"theme":"light"}"#).expect("write partial settings");

        let loaded =
            load_settings_from_source(Some(path.clone())).expect("load partial settings file");

        assert_eq!(loaded.settings.theme, "light");
        assert_eq!(
            loaded.settings.capture_interval_min,
            AppSettings::default().capture_interval_min
        );
        assert_eq!(loaded.warning, None);
        assert!(path.is_file());
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn invalid_settings_file_is_preserved_and_defaults_are_loaded_with_warning() {
        let directory = create_test_directory("invalid-settings");
        let path = directory.join("settings.json");
        let invalid_json = b"{\"theme\":";
        fs::write(&path, invalid_json).expect("write invalid settings");

        let loaded =
            load_settings_from_source(Some(path.clone())).expect("recover invalid settings file");

        assert_eq!(loaded.settings, AppSettings::default());
        let warning = loaded.warning.expect("startup warning");
        assert!(warning.contains("JSON is invalid"));
        assert!(!path.exists());

        let backups = fs::read_dir(&directory)
            .expect("read test directory")
            .map(|entry| entry.expect("read directory entry").path())
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        assert!(
            backups[0]
                .file_name()
                .expect("backup file name")
                .to_string_lossy()
                .starts_with("settings.invalid-")
        );
        assert_eq!(
            fs::read(&backups[0]).expect("read preserved settings"),
            invalid_json
        );
        assert!(warning.contains(&backups[0].display().to_string()));
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn exit_is_allowed_when_capture_is_inactive() {
        assert_eq!(exit_request_action(false, false), ExitRequestAction::Allow);
    }

    #[test]
    fn active_capture_opens_an_exit_confirmation() {
        assert_eq!(exit_request_action(true, false), ExitRequestAction::Prompt);
    }

    #[test]
    fn repeated_exit_request_does_not_open_another_confirmation() {
        assert_eq!(exit_request_action(true, true), ExitRequestAction::Prevent);
    }

    #[test]
    fn child_webview_position_keeps_titlebar_clear() {
        let layout = compute_layout(1320.0, 920.0, 1920.0);
        let scale = 2.0;
        let titlebar = 28.0;

        let (position, _) = child_webview_bounds(&layout, scale, titlebar);

        assert_eq!(
            position.y,
            ((layout.content_y + titlebar) * scale).round() as i32
        );
        assert_eq!(position.y, 152);
    }

    #[test]
    fn child_webview_bottom_stays_inside_inner_content_area() {
        let window_height = 920.0;
        let layout = compute_layout(1320.0, window_height, 1920.0);
        let (position, size) = child_webview_bounds(&layout, 1.0, 28.0);
        let bottom = f64::from(position.y) + f64::from(size.height);

        assert!(bottom <= window_height);
        assert_eq!(bottom, 910.0);
    }

    #[test]
    fn on_screen_window_position_is_unchanged() {
        let position = PhysicalPosition::new(120, 80);
        let size = PhysicalSize::new(800, 600);
        let areas = [WorkArea {
            x: 0,
            y: 24,
            width: 1920,
            height: 1056,
        }];

        assert_eq!(clamp_window_position(position, size, &areas), position);
    }

    #[test]
    fn window_position_is_clamped_to_the_work_area_edges() {
        let areas = [WorkArea {
            x: 0,
            y: 24,
            width: 1920,
            height: 1056,
        }];

        assert_eq!(
            clamp_window_position(
                PhysicalPosition::new(1800, 1000),
                PhysicalSize::new(500, 400),
                &areas,
            ),
            PhysicalPosition::new(1420, 680)
        );
        assert_eq!(
            clamp_window_position(
                PhysicalPosition::new(-200, -100),
                PhysicalSize::new(500, 400),
                &areas,
            ),
            PhysicalPosition::new(0, 24)
        );
    }

    #[test]
    fn position_from_a_disconnected_monitor_moves_to_the_nearest_work_area() {
        let areas = [WorkArea {
            x: 0,
            y: 24,
            width: 1920,
            height: 1056,
        }];

        assert_eq!(
            clamp_window_position(
                PhysicalPosition::new(3000, 200),
                PhysicalSize::new(800, 600),
                &areas,
            ),
            PhysicalPosition::new(1120, 200)
        );
    }

    #[test]
    fn connected_monitor_with_negative_coordinates_is_respected() {
        let areas = [
            WorkArea {
                x: -1280,
                y: 24,
                width: 1280,
                height: 1000,
            },
            WorkArea {
                x: 0,
                y: 24,
                width: 1920,
                height: 1056,
            },
        ];
        let position = PhysicalPosition::new(-1200, 100);

        assert_eq!(
            clamp_window_position(position, PhysicalSize::new(800, 600), &areas),
            position
        );
    }

    #[test]
    fn monitor_with_the_largest_overlap_is_selected() {
        let areas = [
            WorkArea {
                x: 0,
                y: 24,
                width: 1920,
                height: 1056,
            },
            WorkArea {
                x: 1920,
                y: 24,
                width: 1920,
                height: 1056,
            },
        ];

        assert_eq!(
            clamp_window_position(
                PhysicalPosition::new(1700, 100),
                PhysicalSize::new(500, 600),
                &areas,
            ),
            PhysicalPosition::new(1920, 100)
        );
    }

    #[test]
    fn oversized_window_is_aligned_to_the_work_area_origin() {
        let areas = [WorkArea {
            x: -1440,
            y: 24,
            width: 1440,
            height: 876,
        }];

        assert_eq!(
            clamp_window_position(
                PhysicalPosition::new(-1200, 200),
                PhysicalSize::new(1800, 1200),
                &areas,
            ),
            PhysicalPosition::new(-1440, 24)
        );
    }

    #[test]
    fn invalid_saved_window_coordinates_are_discarded() {
        assert_eq!(sanitize_window_coordinate(Some(f64::NAN)), None);
        assert_eq!(sanitize_window_coordinate(Some(f64::INFINITY)), None);
        assert_eq!(
            sanitize_window_coordinate(Some(f64::from(i32::MAX) + 1.0)),
            None
        );
        assert_eq!(sanitize_window_coordinate(Some(-640.0)), Some(-640.0));
    }

    #[test]
    fn window_snapshot_builds_matching_global_and_local_candidates() {
        let global = test_settings();
        let mut local = global.clone();
        local.always_on_top = true;
        local.width_resize_origin = String::from("left");
        let snapshot = WindowSnapshot {
            width: 1440.0,
            height: 900.0,
            x: -320.0,
            y: 48.0,
        };

        let (next_global, next_local) = window_snapshot_candidate(&global, &local, snapshot);

        assert_eq!(next_local.window_width, 1440.0);
        assert_eq!(next_local.window_height, 900.0);
        assert_eq!(next_local.window_x, Some(-320.0));
        assert_eq!(next_local.window_y, Some(48.0));
        assert_eq!(next_global.window_width, next_local.window_width);
        assert_eq!(next_global.window_height, next_local.window_height);
        assert_eq!(next_global.window_x, next_local.window_x);
        assert_eq!(next_global.window_y, next_local.window_y);
        assert!(next_global.always_on_top);
        assert_eq!(next_global.width_resize_origin, "left");
        assert_ne!(global.window_width, next_global.window_width);
    }

    #[test]
    fn settings_save_failure_does_not_commit_either_memory_state() {
        let mut global = test_settings();
        let mut local = global.clone();
        let original_global = global.clone();
        let original_local = local.clone();
        let mut next_global = global.clone();
        let mut next_local = local.clone();
        next_global.window_width = 1600.0;
        next_local.window_width = 1600.0;

        let result =
            save_then_commit_settings(&mut global, &mut local, next_global, next_local, |_| {
                Err(String::from("simulated settings write failure"))
            });

        assert!(result.is_err());
        assert_eq!(global, original_global);
        assert_eq!(local, original_local);
    }

    #[test]
    fn settings_save_success_commits_both_memory_states() {
        let mut global = test_settings();
        let mut local = global.clone();
        let mut next_global = global.clone();
        let mut next_local = local.clone();
        next_global.window_width = 1600.0;
        next_local.window_width = 1600.0;

        save_then_commit_settings(
            &mut global,
            &mut local,
            next_global.clone(),
            next_local.clone(),
            |candidate| {
                assert_eq!(candidate, &next_global);
                Ok(())
            },
        )
        .expect("settings save succeeds");

        assert_eq!(global, next_global);
        assert_eq!(local, next_local);
    }

    #[test]
    fn invalid_directory_rejects_the_entire_settings_patch() {
        let global = test_settings();
        let local = global.clone();
        let original_global = global.clone();
        let original_local = local.clone();
        let patch = SettingsPatch {
            theme: Some(String::from("light")),
            site_url: Some(String::from("https://example.com")),
            capture_directory: Some(String::from(
                "/path/that/does/not/exist/tv-browser-settings-test",
            )),
            ..SettingsPatch::default()
        };

        assert!(prepare_settings_update(&global, &local, patch).is_err());
        assert_eq!(global, original_global);
        assert_eq!(local, original_local);
    }

    #[test]
    fn writable_capture_destination_passes_without_leaving_a_probe() {
        let directory = create_test_directory("writable-capture-destination");
        let settings = AppSettings {
            capture_directory: directory.to_string_lossy().into_owned(),
            ..test_settings()
        };

        validate_capture_destination(&settings).expect("writable destination");

        assert_eq!(
            fs::read_dir(&directory)
                .expect("read test directory")
                .count(),
            0
        );
        fs::remove_dir(directory).expect("remove test directory");
    }

    #[test]
    fn capture_output_writer_creates_and_overwrites_regular_files() {
        let directory = create_test_directory("capture-output-writer");
        let output = directory.join("capture.png");

        write_capture_output(&output, b"first capture").expect("create capture output");
        assert_eq!(
            fs::read(&output).expect("read created capture"),
            b"first capture"
        );

        write_capture_output(&output, b"updated").expect("overwrite capture output");
        assert_eq!(fs::read(&output).expect("read updated capture"), b"updated");
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[test]
    fn non_regular_capture_output_is_rejected() {
        let directory = create_test_directory("non-regular-capture-output");
        let output = directory.join("capture.png");
        fs::create_dir(&output).expect("create directory at capture output path");
        let settings = AppSettings {
            capture_directory: directory.to_string_lossy().into_owned(),
            ..test_settings()
        };

        assert!(validate_capture_destination(&settings).is_err());
        assert!(write_capture_output(&output, b"capture").is_err());
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn capture_output_symlink_is_rejected_without_modifying_target() {
        let directory = create_test_directory("capture-output-symlink");
        let target = directory.join("target.txt");
        let output = directory.join("capture.png");
        fs::write(&target, b"protected contents").expect("create symlink target");
        symlink(&target, &output).expect("create capture output symlink");
        let settings = AppSettings {
            capture_directory: directory.to_string_lossy().into_owned(),
            ..test_settings()
        };

        assert!(validate_capture_destination(&settings).is_err());
        assert!(write_capture_output(&output, b"capture").is_err());
        assert_eq!(
            fs::read(&target).expect("read protected target"),
            b"protected contents"
        );
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn dangling_capture_output_symlink_is_rejected_without_creating_target() {
        let directory = create_test_directory("dangling-capture-output-symlink");
        let target = directory.join("missing-target.txt");
        let output = directory.join("capture.png");
        symlink(&target, &output).expect("create dangling capture output symlink");
        let settings = AppSettings {
            capture_directory: directory.to_string_lossy().into_owned(),
            ..test_settings()
        };

        assert!(validate_capture_destination(&settings).is_err());
        assert!(write_capture_output(&output, b"capture").is_err());
        assert!(!target.exists());
        fs::remove_dir_all(directory).expect("remove test directory");
    }

    #[cfg(unix)]
    #[test]
    fn read_only_capture_directory_is_rejected_transactionally() {
        let directory = create_test_directory("read-only-capture-destination");
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o555))
            .expect("make test directory read-only");
        let global = test_settings();
        let local = global.clone();
        let original_global = global.clone();
        let original_local = local.clone();
        let patch = SettingsPatch {
            theme: Some(String::from("light")),
            capture_directory: Some(directory.to_string_lossy().into_owned()),
            ..SettingsPatch::default()
        };

        let result = prepare_validated_settings_update(&global, &local, patch);

        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755))
            .expect("restore test directory permissions");
        fs::remove_dir(directory).expect("remove test directory");
        assert!(result.is_err());
        assert_eq!(global, original_global);
        assert_eq!(local, original_local);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_existing_capture_file_is_rejected() {
        let directory = create_test_directory("read-only-capture-file");
        let output = directory.join("capture.png");
        fs::write(&output, b"existing capture").expect("create existing capture");
        fs::set_permissions(&output, fs::Permissions::from_mode(0o444))
            .expect("make existing capture read-only");
        let settings = AppSettings {
            capture_directory: directory.to_string_lossy().into_owned(),
            ..test_settings()
        };

        let result = validate_capture_destination(&settings);

        fs::set_permissions(&output, fs::Permissions::from_mode(0o644))
            .expect("restore capture permissions");
        fs::remove_file(output).expect("remove test capture");
        fs::remove_dir(directory).expect("remove test directory");
        assert!(result.is_err());
    }

    #[test]
    fn invalid_url_rejects_the_entire_settings_patch() {
        let global = test_settings();
        let local = global.clone();
        let patch = SettingsPatch {
            theme: Some(String::from("light")),
            site_url: Some(String::from("http://example.com")),
            ..SettingsPatch::default()
        };

        assert!(prepare_settings_update(&global, &local, patch).is_err());
        assert_eq!(global.theme, "dark");
        assert_eq!(local.theme, "dark");
    }

    #[test]
    fn valid_settings_patch_is_applied_as_one_candidate() {
        let global = test_settings();
        let local = global.clone();
        let capture_directory = std::env::temp_dir().to_string_lossy().into_owned();
        let patch = SettingsPatch {
            theme: Some(String::from("light")),
            always_on_top: Some(true),
            site_url: Some(String::from("https://example.com")),
            width_resize_origin: Some(String::from("left")),
            capture_interval_min: Some(15),
            capture_file_name: Some(String::from("updated.png")),
            capture_directory: Some(capture_directory.clone()),
            wide_mode_width: Some(1600.0),
            narrow_mode_width: Some(400.0),
        };

        let (next_global, next_local) =
            prepare_settings_update(&global, &local, patch).expect("valid settings patch");

        assert_eq!(next_global.theme, "light");
        assert_eq!(next_global.site_url, "https://example.com");
        assert_eq!(next_global.capture_interval_min, 15);
        assert_eq!(next_global.capture_file_name, "updated");
        assert_eq!(next_global.capture_directory, capture_directory);
        assert_eq!(next_global.wide_mode_width, 1600.0);
        assert_eq!(next_global.narrow_mode_width, 400.0);
        assert!(next_global.always_on_top);
        assert!(next_local.always_on_top);
        assert_eq!(next_global.width_resize_origin, "left");
        assert_eq!(next_local.width_resize_origin, "left");
    }

    #[test]
    fn partial_width_patch_is_validated_with_existing_width() {
        let global = test_settings();
        let local = global.clone();
        let patch = SettingsPatch {
            wide_mode_width: Some(1500.0),
            ..SettingsPatch::default()
        };

        let (next_global, _) =
            prepare_settings_update(&global, &local, patch).expect("valid partial width patch");

        assert_eq!(next_global.wide_mode_width, 1500.0);
        assert_eq!(next_global.narrow_mode_width, global.narrow_mode_width);
    }

    fn jst_time(hour: u64, minute: u64, second: u64) -> std::time::SystemTime {
        let start_of_jst_day = 15 * 60 * 60;
        UNIX_EPOCH + Duration::from_secs(start_of_jst_day + hour * 60 * 60 + minute * 60 + second)
    }

    #[test]
    fn capture_delay_targets_five_seconds_after_the_next_interval_boundary() {
        assert_eq!(
            next_capture_delay(jst_time(10, 4, 59), 5),
            Duration::from_secs(6)
        );
        assert_eq!(
            next_capture_delay(jst_time(10, 5, 5), 5),
            Duration::from_secs(5 * 60)
        );
    }

    #[test]
    fn four_hour_capture_interval_uses_fixed_jst_boundaries() {
        assert_eq!(
            next_capture_delay(jst_time(2, 30, 0), 240),
            Duration::from_secs(90 * 60 + 5)
        );
        assert_eq!(
            next_capture_delay(jst_time(4, 0, 1), 240),
            Duration::from_secs(4 * 60 * 60 + 4)
        );
    }
}
