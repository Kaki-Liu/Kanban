use crate::store::Store;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent,
};
use tauri_plugin_autostart::ManagerExt as AutoStartExt;
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
use tauri_plugin_opener::OpenerExt;

pub struct Runtime {
    store: Mutex<Store>,
    dirty: Mutex<HashMap<String, bool>>,
    active: Mutex<HashSet<String>>,
    locked: AtomicBool,
    quitting: AtomicBool,
    ticking: AtomicBool,
    widget_moved: AtomicU64,
    closing: Mutex<HashSet<String>>,
}
type Shared = Arc<Runtime>;
type Result<T> = std::result::Result<T, String>;
fn millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn state(app: &AppHandle) -> Shared {
    app.state::<Shared>().inner().clone()
}
fn broadcast(app: &AppHandle) {
    let _ = app.emit("kb:changed", ());
}
fn arg<'a>(args: &'a [Value], n: usize) -> Result<&'a Value> {
    args.get(n).ok_or_else(|| "缺少参数".into())
}
fn string(args: &[Value], n: usize) -> Result<String> {
    arg(args, n)?
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| "参数需要文本".into())
}
fn boolean(args: &[Value], n: usize) -> Result<bool> {
    arg(args, n)?
        .as_bool()
        .ok_or_else(|| "参数需要布尔值".into())
}
fn show_main(app: &AppHandle, id: Option<String>) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
        if let Some(id) = id {
            let _ = w.emit("kb:open-run", id);
        }
    }
}
fn show_quick(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("quick") {
        let _ = w.show();
        let _ = w.set_focus();
        let _ = w.emit("kb:changed", ());
    }
}
fn show_inactive(w: &WebviewWindow) {
    #[cfg(windows)]
    unsafe {
        if let Ok(handle) = w.hwnd() {
            windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
                handle.0 as _,
                windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNOACTIVATE,
            );
        }
    }
    #[cfg(not(windows))]
    {
        let _ = w.show();
    }
}
fn hide_window(w: &WebviewWindow) -> Result<()> {
    w.hide().map_err(err)?;
    // Native inactive show bypasses Tao's cached visibility flag. Explicitly
    // hide the HWND too; a cached false -> false transition is otherwise a no-op.
    #[cfg(windows)]
    unsafe {
        let handle = w.hwnd().map_err(err)?;
        windows_sys::Win32::UI::WindowsAndMessaging::ShowWindow(
            handle.0 as _,
            windows_sys::Win32::UI::WindowsAndMessaging::SW_HIDE,
        );
    }
    Ok(())
}
#[cfg(windows)]
fn session_locked() -> Option<bool> {
    use windows_sys::Win32::System::{
        RemoteDesktop::{
            ProcessIdToSessionId, WTSFreeMemory, WTSQuerySessionInformationW, WTSSessionInfoEx,
            WTSINFOEXW, WTS_CURRENT_SERVER_HANDLE, WTS_SESSIONSTATE_LOCK, WTS_SESSIONSTATE_UNLOCK,
        },
        Threading::GetCurrentProcessId,
    };
    unsafe {
        let mut session = 0;
        if ProcessIdToSessionId(GetCurrentProcessId(), &mut session) == 0 {
            return None;
        }
        let mut buffer = std::ptr::null_mut();
        let mut bytes = 0;
        if WTSQuerySessionInformationW(
            WTS_CURRENT_SERVER_HANDLE,
            session,
            WTSSessionInfoEx,
            &mut buffer,
            &mut bytes,
        ) == 0
        {
            return None;
        }
        let result = if !buffer.is_null() && bytes as usize >= std::mem::size_of::<WTSINFOEXW>() {
            let info = &*(buffer as *const WTSINFOEXW);
            if info.Level == 1 {
                // Windows 11 uses LOCK=0, UNLOCK=1 (the Windows 7 reversal is not supported).
                match info.Data.WTSInfoExLevel1.SessionFlags as u32 {
                    WTS_SESSIONSTATE_LOCK => Some(true),
                    WTS_SESSIONSTATE_UNLOCK => Some(false),
                    _ => None,
                }
            } else {
                None
            }
        } else {
            None
        };
        WTSFreeMemory(buffer as _);
        result
    }
}
#[cfg(not(windows))]
fn session_locked() -> Option<bool> {
    Some(false)
}
fn apply_session_lock(app: &AppHandle, locked: bool) {
    let st = state(app);
    if st.locked.swap(locked, Ordering::SeqCst) == locked {
        return;
    }
    if locked {
        for label in ["reminder", "widget"] {
            if let Some(w) = app.get_webview_window(label) {
                let _ = hide_window(&w);
            }
        }
    } else {
        let visible = st
            .store
            .lock()
            .ok()
            .and_then(|s| s.widget_preferences().ok())
            .is_some_and(|p| p["visible"] == true);
        if visible {
            if let Some(w) = app.get_webview_window("widget") {
                show_inactive(&w);
            }
        }
        if st.active.lock().is_ok_and(|active| !active.is_empty()) {
            if let Some(w) = app.get_webview_window("reminder") {
                show_inactive(&w);
            }
        }
    }
}
fn widget_bounds(w: &WebviewWindow) -> Result<Value> {
    let scale = w.scale_factor().map_err(err)?;
    let p = w.outer_position().map_err(err)?.to_logical::<i32>(scale);
    let size = w.inner_size().map_err(err)?.to_logical::<u32>(scale);
    Ok(json!({"x":p.x,"y":p.y,"width":size.width,"height":size.height}))
}
fn save_widget_bounds(app: &AppHandle) -> Result<()> {
    let Some(w) = app.get_webview_window("widget") else {
        return Ok(());
    };
    let bounds = widget_bounds(&w)?;
    let st = state(app);
    let mut s = st.store.lock().map_err(err)?;
    let mut prefs = s.widget_preferences()?;
    prefs["bounds"] = bounds;
    s.save_widget_preferences(prefs)
}
fn position_widget(app: &AppHandle) -> Result<()> {
    let w = app.get_webview_window("widget").ok_or("便签窗口不存在")?;
    let was_visible = w.is_visible().map_err(err)?;
    let prefs = state(app).store.lock().map_err(err)?.widget_preferences()?;
    let b = &prefs["bounds"];
    let monitors = w.available_monitors().map_err(err)?;
    let monitor = monitors
        .iter()
        .find(|m| {
            let scale = m.scale_factor();
            let p = m.position().to_logical::<f64>(scale);
            let size = m.size().to_logical::<f64>(scale);
            let x = b["x"].as_f64().unwrap_or(-1.0);
            let y = b["y"].as_f64().unwrap_or(-1.0);
            x >= p.x && x < p.x + size.width && y >= p.y && y < p.y + size.height
        })
        .cloned()
        .or(w.primary_monitor().map_err(err)?)
        .ok_or("无法获取屏幕范围")?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let p = area.position.to_logical::<f64>(scale);
    let size = area.size.to_logical::<f64>(scale);
    let width = b["width"]
        .as_f64()
        .unwrap_or(380.0)
        .clamp(340.0, 560.0)
        .min(size.width);
    let height = b["height"]
        .as_f64()
        .unwrap_or(560.0)
        .clamp(420.0, 900.0)
        .min(size.height);
    let x = b["x"]
        .as_f64()
        .unwrap_or(p.x + size.width - width - 16.0)
        .clamp(p.x, p.x + size.width - width);
    let y = b["y"]
        .as_f64()
        .unwrap_or(p.y + 60.0)
        .clamp(p.y, p.y + size.height - height);
    w.set_min_size(Some(tauri::PhysicalSize::new(
        (340.0_f64.min(size.width) * scale).round() as u32,
        (420.0_f64.min(size.height) * scale).round() as u32,
    )))
    .map_err(err)?;
    w.set_position(tauri::PhysicalPosition::new(
        (x * scale).round() as i32,
        (y * scale).round() as i32,
    ))
    .map_err(err)?;
    w.set_size(tauri::PhysicalSize::new(
        (width * scale).round() as u32,
        (height * scale).round() as u32,
    ))
    .map_err(err)?;
    w.set_always_on_top(prefs["pinned"].as_bool().unwrap_or(true))
        .map_err(err)?;
    let _ = w.is_visible().map_err(err)?;
    if was_visible && !state(app).locked.load(Ordering::SeqCst) {
        show_inactive(&w);
    }
    Ok(())
}
fn widget_visible(app: &AppHandle, visible: bool) -> Result<()> {
    let st = state(app);
    let w = app.get_webview_window("widget").ok_or("便签窗口不存在")?;
    {
        let mut s = st.store.lock().map_err(err)?;
        let mut p = s.widget_preferences()?;
        p["visible"] = json!(visible);
        if !visible {
            p["bounds"] = widget_bounds(&w)?;
        }
        s.save_widget_preferences(p)?;
    }
    if visible {
        position_widget(app)?;
        if !st.locked.load(Ordering::SeqCst) {
            show_inactive(&w);
        }
        let _ = w.emit("kb:changed", ());
    } else {
        hide_window(&w)?;
    }
    Ok(())
}
fn visible_reminders(app: &AppHandle) -> Result<Vec<Value>> {
    let st = state(app);
    let s = st.store.lock().map_err(err)?;
    let shown: HashSet<_> = s
        .reminders()?
        .iter()
        .filter(|r| r["status"] == "shown")
        .filter_map(|r| r["runId"].as_str().map(str::to_owned))
        .collect();
    let mut active = st.active.lock().map_err(err)?;
    let mut result = Vec::new();
    active.retain(|id| {
        if !shown.contains(id) {
            return false;
        }
        if let Ok(run) = s.get_run(id) {
            if run["state"] == "pending" || run["state"] == "doing" {
                result.push(run);
                return true;
            }
        }
        false
    });
    Ok(result)
}
fn hide_empty_reminder(app: &AppHandle) -> Result<()> {
    visible_reminders(app)?;
    let st = state(app);
    // Serialize the empty check/hide with tick's show/persist/publish sequence.
    let _store = st.store.lock().map_err(err)?;
    let active = st.active.lock().map_err(err)?;
    if active.is_empty() {
        if let Some(w) = app.get_webview_window("reminder") {
            hide_window(&w)?;
        }
    }
    Ok(())
}
fn tick(app: &AppHandle) -> Result<()> {
    let st = state(app);
    if st.ticking.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    struct TickGuard<'a>(&'a AtomicBool);
    impl Drop for TickGuard<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let _guard = TickGuard(&st.ticking);
    if st.quitting.load(Ordering::SeqCst) {
        return Ok(());
    }
    let generated = st.store.lock().map_err(err)?.ensure_today()?;
    if generated {
        broadcast(app);
    }
    if let Some(locked) = session_locked() {
        apply_session_lock(app, locked);
    }
    if st.locked.load(Ordering::SeqCst) {
        return Ok(());
    }
    let due = st.store.lock().map_err(err)?.due_reminders()?;
    let remaining = visible_reminders(app)?;
    let Some(w) = app.get_webview_window("reminder") else {
        return Ok(());
    };
    if due.is_empty() && remaining.is_empty() {
        hide_window(&w)?;
    }
    if !due.is_empty() {
        let ids: Vec<String> = due
            .iter()
            .filter_map(|r| r["id"].as_str().map(str::to_owned))
            .collect();
        if let Some(m) = w
            .current_monitor()
            .map_err(err)?
            .or(w.primary_monitor().map_err(err)?)
        {
            let scale = m.scale_factor();
            let a = m.work_area();
            let p = a.position.to_logical::<f64>(scale);
            let s = a.size.to_logical::<f64>(scale);
            let width = 420.0_f64.min(s.width);
            let height = 360.0_f64.min(s.height);
            w.set_size(tauri::LogicalSize::new(width, height))
                .map_err(err)?;
            w.set_position(tauri::LogicalPosition::new(
                p.x + (s.width - width - 20.0).max(0.0),
                p.y + (s.height - height - 20.0).max(0.0),
            ))
            .map_err(err)?;
        }
        w.set_always_on_top(true).map_err(err)?;
        if let Some(locked) = session_locked() {
            apply_session_lock(app, locked);
        }
        if st.locked.load(Ordering::SeqCst) {
            return Ok(());
        }
        {
            // Publish only persisted "shown" reminders. A concurrent renderer
            // refresh removes pending reminders from the active display list.
            let mut store = st.store.lock().map_err(err)?;
            show_inactive(&w);
            store.mark_shown(&ids)?;
            st.active.lock().map_err(err)?.extend(ids);
        }
        broadcast(app);
    }
    if let Some(w) = app.get_webview_window("widget") {
        if w.is_visible().unwrap_or(false) {
            let _ = w.emit("kb:changed", ());
        }
    }
    Ok(())
}
fn confirm_discard(app: &AppHandle, label: &str) -> bool {
    let st = state(app);
    if !st
        .dirty
        .lock()
        .unwrap()
        .get(label)
        .copied()
        .unwrap_or(false)
    {
        return true;
    }
    let discard = app
        .dialog()
        .message("有尚未保存的内容。放弃后关闭吗？")
        .title("未保存的内容")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "放弃并关闭".into(),
            "继续编辑".into(),
        ))
        .blocking_show();
    if discard {
        st.dirty.lock().unwrap().insert(label.into(), false);
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.eval("location.reload()");
        }
    }
    discard
}
fn close_window(app: &AppHandle, label: &str) -> Result<()> {
    if !confirm_discard(app, label) {
        return Ok(());
    }
    if label == "widget" {
        return widget_visible(app, false);
    }
    if label == "reminder" {
        let st = state(app);
        let ids: Vec<String> = st.active.lock().map_err(err)?.drain().collect();
        st.store.lock().map_err(err)?.dismiss(&ids)?;
        broadcast(app);
    }
    if let Some(w) = app.get_webview_window(label) {
        hide_window(&w)?;
    }
    Ok(())
}
fn ask_exit(app: AppHandle) {
    std::thread::spawn(move || {
        for label in ["main", "quick"] {
            if !confirm_discard(&app, label) {
                return;
            }
        }
        let _ = save_widget_bounds(&app);
        state(&app).quitting.store(true, Ordering::SeqCst);
        app.exit(0);
    });
}
fn register_shortcut(app: &AppHandle, text: &str) -> Result<()> {
    let shortcut: Shortcut = text.parse().map_err(err)?;
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state == ShortcutState::Pressed {
                show_quick(app);
            }
        })
        .map_err(|_| "快捷键不可用或已被占用，请选择其他组合。".to_string())
}
fn set_autostart(app: &AppHandle, enabled: bool) -> Result<()> {
    if std::env::var_os("KANBAN_E2E").is_some() {
        return Ok(());
    }
    if enabled {
        app.autolaunch().enable().map_err(err)
    } else {
        app.autolaunch().disable().map_err(err)
    }
}
fn selected_file(app: &AppHandle, save: bool, name: &str, extension: &str) -> Option<PathBuf> {
    let dialog = app.dialog().file().add_filter(name, &[extension]);
    let file = if save {
        dialog.set_file_name(name).blocking_save_file()
    } else {
        dialog.blocking_pick_file()
    };
    file.and_then(|p| p.into_path().ok())
}
fn save_text(app: &AppHandle, name: &str, extension: &str, text: &str) -> Result<Value> {
    if let Some(path) = selected_file(app, true, name, extension) {
        std::fs::write(path, text).map_err(err)?;
        Ok(json!(true))
    } else {
        Ok(json!(false))
    }
}

#[tauri::command]
pub fn kb_dirty(window: WebviewWindow, value: bool) {
    if ["main", "quick"].contains(&window.label()) {
        state(window.app_handle())
            .dirty
            .lock()
            .unwrap()
            .insert(window.label().into(), value);
    }
}
#[tauri::command]
pub async fn kb_call(window: WebviewWindow, channel: String, args: Vec<Value>) -> Result<Value> {
    tauri::async_runtime::spawn_blocking(move || handle(&window, &channel, args))
        .await
        .map_err(err)?
}
fn handle(window: &WebviewWindow, channel: &str, args: Vec<Value>) -> Result<Value> {
    let label = window.label();
    let app = window.app_handle();
    let st = state(app);
    let allowed = match label {
        "main" => true,
        "quick" => ["snapshot", "logs.save", "window.close"].contains(&channel),
        "reminder" => channel.starts_with("reminders.") || channel == "window.close",
        "widget" => [
            "widget.get",
            "widget.setPinned",
            "widget.hide",
            "widget.openMain",
            "items.check",
            "window.close",
            "window.drag",
        ]
        .contains(&channel),
        _ => false,
    };
    if !allowed {
        return Err("此窗口无此权限".into());
    }
    if serde_json::to_vec(&args).map_err(err)?.len() > 6_000_000 {
        return Err("请求内容过大".into());
    }
    if label == "widget" && channel == "items.check" {
        let snap = st.store.lock().map_err(err)?.widget_snapshot()?;
        if !snap["checklists"]
            .as_array()
            .unwrap_or(&Vec::new())
            .iter()
            .any(|r| args.first().is_some_and(|id| &r["id"] == id))
        {
            return Err("便签只能勾选今天的检查清单".into());
        }
    }
    let revision = st.store.lock().map_err(err)?.revision()?;
    let result = (|| -> Result<Value> {
        match channel {
            "window.close" => {
                close_window(app, label)?;
                Ok(Value::Null)
            }
            "window.drag" => {
                window.start_dragging().map_err(err)?;
                Ok(Value::Null)
            }
            "window.copyText" => {
                let text = string(&args, 0)?;
                if text.len() > 2_000_000 {
                    return Err("内容超过 2 MB".into());
                }
                app.clipboard().write_text(text).map_err(err)?;
                Ok(Value::Null)
            }
            "window.external" => {
                let url = string(&args, 0)?;
                let parsed = tauri::Url::parse(&url).map_err(err)?;
                if !["https", "http"].contains(&parsed.scheme()) {
                    return Err("仅支持网页链接".into());
                }
                app.opener().open_url(url, None::<&str>).map_err(err)?;
                Ok(Value::Null)
            }
            "widget.show" => {
                widget_visible(app, true)?;
                Ok(Value::Null)
            }
            "widget.hide" => {
                widget_visible(app, false)?;
                Ok(Value::Null)
            }
            "widget.setPinned" => {
                let pinned = boolean(&args, 0)?;
                {
                    let mut s = st.store.lock().map_err(err)?;
                    let mut p = s.widget_preferences()?;
                    p["pinned"] = json!(pinned);
                    s.save_widget_preferences(p)?;
                }
                let widget = app.get_webview_window("widget").ok_or("便签不存在")?;
                let was_visible = widget.is_visible().map_err(err)?;
                widget.set_always_on_top(pinned).map_err(err)?;
                // Wait for the queued style change, which may apply Tao's cached
                // hidden state, before preserving the native inactive visibility.
                let _ = widget.is_visible().map_err(err)?;
                if was_visible && !st.locked.load(Ordering::SeqCst) {
                    show_inactive(&widget);
                }
                broadcast(app);
                Ok(Value::Null)
            }
            "widget.openMain" | "reminders.open" => {
                let id = args.first().and_then(Value::as_str).map(str::to_owned);
                if let Some(ref id) = id {
                    st.store.lock().map_err(err)?.get_run(id)?;
                }
                show_main(app, id);
                Ok(Value::Null)
            }
            "reminders.list" => Ok(json!(visible_reminders(app)?)),
            "reminders.dismiss" => {
                let ids: Vec<String> =
                    serde_json::from_value(arg(&args, 0)?.clone()).map_err(err)?;
                st.store.lock().map_err(err)?.dismiss(&ids)?;
                {
                    let mut active = st.active.lock().map_err(err)?;
                    for id in ids {
                        active.remove(&id);
                    }
                }
                hide_empty_reminder(app)?;
                Ok(Value::Null)
            }
            "reminders.snooze" => {
                let id = string(&args, 0)?;
                st.store.lock().map_err(err)?.snooze(&id)?;
                st.active.lock().map_err(err)?.remove(&id);
                hide_empty_reminder(app)?;
                Ok(Value::Null)
            }
            "imports.read" => {
                if let Some(p) = selected_file(app, false, "JSON 配置", "json") {
                    if std::fs::metadata(&p).map_err(err)?.len() > 2_000_000 {
                        return Err("配置文件不能超过 2 MB".into());
                    }
                    Ok(json!(std::fs::read_to_string(p).map_err(err)?))
                } else {
                    Ok(Value::Null)
                }
            }
            "imports.export" => {
                let text = st
                    .store
                    .lock()
                    .map_err(err)?
                    .dispatch("imports.export", vec![])?;
                save_text(
                    app,
                    "kanban-config.json",
                    "json",
                    text.as_str().ok_or("配置导出错误")?,
                )
            }
            "projects.config.saveFile" => {
                let text = string(&args, 0)?;
                let value = Store::parse_project_config(&text)?;
                let pretty = serde_json::to_string_pretty(&value).map_err(err)?;
                save_text(app, "kanban-project.json", "json", &pretty)
            }
            "reports.output" => {
                let text = st
                    .store
                    .lock()
                    .map_err(err)?
                    .dispatch("reports.markdown", args.clone())?;
                let text = text.as_str().ok_or("汇报格式错误")?;
                if boolean(&args, 2)? {
                    save_text(app, "工作汇报素材.md", "md", text)
                } else {
                    app.clipboard().write_text(text.to_string()).map_err(err)?;
                    Ok(json!(true))
                }
            }
            "backup.create" => {
                if let Some(p) = selected_file(app, true, "kanban.kanban-backup", "kanban-backup") {
                    st.store
                        .lock()
                        .map_err(err)?
                        .dispatch("backup.create", vec![json!(p)])?;
                    Ok(json!(true))
                } else {
                    Ok(json!(false))
                }
            }
            "backup.preview" => {
                if let Some(p) = selected_file(app, false, "看板备份", "kanban-backup") {
                    st.store
                        .lock()
                        .map_err(err)?
                        .dispatch(channel, vec![json!(p)])
                } else {
                    Ok(Value::Null)
                }
            }
            "backup.restore" => {
                let result = st
                    .store
                    .lock()
                    .map_err(err)?
                    .dispatch(channel, args.clone())?;
                st.active.lock().map_err(err)?.clear();
                let _ = app.global_shortcut().unregister_all();
                let settings = st.store.lock().map_err(err)?.settings()?;
                let mut warnings = Vec::new();
                if let Err(e) =
                    register_shortcut(app, settings["shortcut"].as_str().unwrap_or("Ctrl+Alt+J"))
                {
                    warnings.push(e);
                }
                if let Err(e) = set_autostart(app, settings["autoStart"].as_bool().unwrap_or(false))
                {
                    warnings.push(format!("开机启动设置未能应用：{e}"));
                }
                if let Err(e) = position_widget(app) {
                    warnings.push(format!("便签位置未能恢复：{e}"));
                }
                let prefs = st.store.lock().map_err(err)?.widget_preferences()?;
                if prefs["visible"] == true && !st.locked.load(Ordering::SeqCst) {
                    if let Some(w) = app.get_webview_window("widget") {
                        show_inactive(&w);
                    }
                } else if let Some(w) = app.get_webview_window("widget") {
                    let _ = hide_window(&w);
                }
                if !warnings.is_empty() {
                    app.dialog()
                        .message(format!(
                            "备份数据已恢复。以下桌面设置需要重新调整：\n{}",
                            warnings.join("\n")
                        ))
                        .kind(MessageDialogKind::Warning)
                        .show(|_| {});
                }
                Ok(result)
            }
            "settings.save" => {
                let next = arg(&args, 0)?.clone();
                let previous = st.store.lock().map_err(err)?.settings()?;
                let new = next["shortcut"].as_str().ok_or("缺少快捷键")?;
                let old = previous["shortcut"].as_str().unwrap_or("Ctrl+Alt+J");
                let enabled = next["autoStart"].as_bool().ok_or("缺少开机启动选项")?;
                if new != old {
                    register_shortcut(app, new)?;
                }
                let result = (|| {
                    set_autostart(app, enabled)?;
                    st.store
                        .lock()
                        .map_err(err)?
                        .dispatch(channel, args.clone())
                })();
                if result.is_err() {
                    let _ = set_autostart(app, previous["autoStart"].as_bool().unwrap_or(false));
                    if new != old {
                        let _ = app
                            .global_shortcut()
                            .unregister(new.parse::<Shortcut>().map_err(err)?);
                    }
                } else if new != old {
                    let _ = app
                        .global_shortcut()
                        .unregister(old.parse::<Shortcut>().map_err(err)?);
                }
                result
            }
            _ => st
                .store
                .lock()
                .map_err(err)?
                .dispatch(channel, args.clone()),
        }
    })();
    if revision != st.store.lock().map_err(err)?.revision()?
        || channel.starts_with("reminders.") && channel != "reminders.list"
    {
        broadcast(app);
        let _ = tick(app);
    }
    result
}

fn data_dir() -> Result<PathBuf> {
    if let Some(p) = std::env::var_os("KANBAN_DATA_DIR") {
        return Ok(PathBuf::from(p));
    }
    let base = std::env::var_os("APPDATA").ok_or("无法定位 Windows 用户数据目录")?;
    Ok(PathBuf::from(base).join(if cfg!(debug_assertions) {
        "Kanban-dev"
    } else {
        "Kanban"
    }))
}
#[cfg(windows)]
fn reject_legacy_instance() -> Result<()> {
    // Electron and Tauri use different singleton mechanisms. Never let both write
    // the user's production database while transitioning between runtimes.
    if cfg!(debug_assertions) || std::env::var_os("KANBAN_DATA_DIR").is_some() {
        return Ok(());
    }
    use windows_sys::Win32::{
        Foundation::{CloseHandle, INVALID_HANDLE_VALUE},
        System::{
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::GetCurrentProcessId,
        },
    };
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot == INVALID_HANDLE_VALUE {
            return Err("无法检查旧版是否仍在运行，请稍后重试。".into());
        }
        let mut entry: PROCESSENTRY32W = std::mem::zeroed();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        let mut has = Process32FirstW(snapshot, &mut entry) != 0;
        let mut running = false;
        while has {
            let len = entry
                .szExeFile
                .iter()
                .position(|c| *c == 0)
                .unwrap_or(entry.szExeFile.len());
            let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
            if entry.th32ProcessID != GetCurrentProcessId()
                && name.eq_ignore_ascii_case("kanban.exe")
            {
                running = true;
                break;
            }
            has = Process32NextW(snapshot, &mut entry) != 0;
        }
        CloseHandle(snapshot);
        if running {
            return Err(
                "旧版工作看板仍在运行。请从旧版托盘菜单退出后，再打开 Rust 版；原数据会保留。"
                    .into(),
            );
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn reject_legacy_instance() -> Result<()> {
    Ok(())
}
pub fn run() {
    let mut context = tauri::generate_context!();
    if std::env::var_os("KANBAN_E2E").is_some() {
        if let Some(directory) = std::env::var_os("KANBAN_DATA_DIR") {
            // Isolated UI tests must not forward activation to the user's running app.
            use std::hash::{Hash, Hasher};
            let mut hash = std::collections::hash_map::DefaultHasher::new();
            directory.hash(&mut hash);
            context.config_mut().identifier = format!("local.kanban.test.{:x}", hash.finish());
        }
    }
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app, None)
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .invoke_handler(tauri::generate_handler![kb_call, kb_dirty])
        .setup(|app| {
            reject_legacy_instance().map_err(std::io::Error::other)?;
            let dir = data_dir().map_err(std::io::Error::other)?;
            std::fs::create_dir_all(&dir)?;
            let mut store = Store::new(dir.join("kanban.db")).map_err(std::io::Error::other)?;
            store
                .prepare_version(env!("CARGO_PKG_VERSION"))
                .map_err(std::io::Error::other)?;
            let prefs = store.widget_preferences().map_err(std::io::Error::other)?;
            let settings = store.settings().map_err(std::io::Error::other)?;
            let initial_locked = session_locked();
            app.manage(Arc::new(Runtime {
                store: Mutex::new(store),
                dirty: Mutex::new(HashMap::new()),
                active: Mutex::new(HashSet::new()),
                locked: AtomicBool::new(initial_locked.unwrap_or(true)),
                quitting: AtomicBool::new(false),
                ticking: AtomicBool::new(false),
                widget_moved: AtomicU64::new(0),
                closing: Mutex::new(HashSet::new()),
            }));
            for (kind, title, width, height) in [
                ("main", "本地工作看板", 1200.0, 800.0),
                ("quick", "随手记", 600.0, 300.0),
                ("reminder", "到点提醒", 420.0, 360.0),
                ("widget", "桌面便签", 380.0, 560.0),
            ] {
                let mut window = WebviewWindowBuilder::new(
                    app,
                    kind,
                    WebviewUrl::App(format!("index.html?window={kind}").into()),
                )
                .title(title)
                .inner_size(width, height)
                .visible(false)
                .focused(false)
                .data_directory(dir.join("webview"))
                .on_navigation(|url| {
                    (url.scheme() == "tauri" && url.host_str() == Some("localhost"))
                        || (url.scheme() == "http" && url.host_str() == Some("tauri.localhost"))
                        || (cfg!(debug_assertions)
                            && url.scheme() == "http"
                            && [Some("localhost"), Some("127.0.0.1")].contains(&url.host_str())
                            && url.port() == Some(1420))
                })
                .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
                .on_permission_request(|_, _| tauri::webview::PermissionResponse::Deny);
                if std::env::var_os("KANBAN_E2E").is_some()
                    && std::env::var_os("KANBAN_DATA_DIR").is_some()
                {
                    if let Ok(port) = std::env::var("KANBAN_CDP_PORT")
                        .unwrap_or_default()
                        .parse::<u16>()
                    {
                        window = window
                            .additional_browser_args(&format!("--remote-debugging-port={port}"));
                    }
                }
                if kind == "main" {
                    window = window.min_inner_size(850.0, 600.0);
                } else if kind == "widget" {
                    window = window
                        .decorations(false)
                        .min_inner_size(340.0, 420.0)
                        .max_inner_size(560.0, 900.0)
                        .maximizable(false)
                        .minimizable(false)
                        .skip_taskbar(true)
                        .always_on_top(prefs["pinned"].as_bool().unwrap_or(true));
                } else {
                    window = window
                        .min_inner_size(320.0, 220.0)
                        .skip_taskbar(kind == "reminder")
                        .always_on_top(kind == "reminder");
                }
                let window = window.build()?;
                let handle = app.handle().clone();
                let label = kind.to_owned();
                window.on_window_event(move |event| {
                    let st = state(&handle);
                    match event {
                        WindowEvent::CloseRequested { api, .. } => {
                            if !st.quitting.load(Ordering::SeqCst) {
                                api.prevent_close();
                                if st.closing.lock().unwrap().insert(label.clone()) {
                                    let app = handle.clone();
                                    let label = label.clone();
                                    std::thread::spawn(move || {
                                        if let Err(e) = close_window(&app, &label) {
                                            app.dialog()
                                                .message(e)
                                                .kind(MessageDialogKind::Error)
                                                .show(|_| {});
                                        }
                                        state(&app).closing.lock().unwrap().remove(&label);
                                    });
                                }
                            }
                        }
                        WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                            if label == "widget" {
                                st.widget_moved.store(millis(), Ordering::SeqCst);
                            }
                        }
                        WindowEvent::ScaleFactorChanged { .. } => {
                            let app = handle.clone();
                            std::thread::spawn(move || {
                                let _ = position_widget(&app);
                            });
                        }
                        _ => {}
                    }
                });
            }
            position_widget(app.handle()).map_err(std::io::Error::other)?;
            let menu = tauri::menu::MenuBuilder::new(app)
                .text("open", "打开看板")
                .text("widget", "显示 / 隐藏桌面便签")
                .text("quick", "随手记")
                .separator()
                .text("quit", "退出")
                .build()?;
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("本地工作看板")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app, None),
                    "quick" => show_quick(app),
                    "quit" => ask_exit(app.clone()),
                    "widget" => {
                        let app = app.clone();
                        std::thread::spawn(move || {
                            let visible = state(&app)
                                .store
                                .lock()
                                .unwrap()
                                .widget_preferences()
                                .map(|v| v["visible"] == true)
                                .unwrap_or(false);
                            let _ = widget_visible(&app, !visible);
                        });
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(event, tauri::tray::TrayIconEvent::DoubleClick { .. }) {
                        show_main(tray.app_handle(), None);
                    }
                })
                .build(app)?;
            if let Err(e) = install_windows_events(app.handle()) {
                app.dialog()
                    .message(format!(
                        "系统事件监听暂时不可用，将每 5 秒核对锁屏和提醒状态：{e}"
                    ))
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
            if initial_locked.is_none() {
                app.dialog()
                    .message("暂时无法确认锁屏状态，提醒会保留待发送并自动重试。")
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
            show_main(app.handle(), None);
            if prefs["visible"] == true && !state(app.handle()).locked.load(Ordering::SeqCst) {
                if let Some(w) = app.get_webview_window("widget") {
                    show_inactive(&w);
                }
            }
            if let Err(e) = register_shortcut(
                app.handle(),
                settings["shortcut"].as_str().unwrap_or("Ctrl+Alt+J"),
            ) {
                if std::env::var_os("KANBAN_E2E").is_some()
                    && std::env::var_os("KANBAN_DATA_DIR").is_some()
                {
                    eprintln!("Shortcut: {e}");
                } else {
                    app.dialog()
                        .message(e)
                        .kind(MessageDialogKind::Warning)
                        .show(|_| {});
                }
            }
            if let Err(e) = set_autostart(
                app.handle(),
                settings["autoStart"].as_bool().unwrap_or(false),
            ) {
                app.dialog()
                    .message(format!("看板已打开，但开机启动设置未能应用：{e}"))
                    .kind(MessageDialogKind::Warning)
                    .show(|_| {});
            }
            let app = app.handle().clone();
            std::thread::spawn(move || {
                let mut last = 0;
                loop {
                    let st = state(&app);
                    if st.quitting.load(Ordering::SeqCst) {
                        break;
                    }
                    let now = millis();
                    let moved = st.widget_moved.load(Ordering::SeqCst);
                    if moved != 0 && now.saturating_sub(moved) >= 250 {
                        if st
                            .widget_moved
                            .compare_exchange(moved, 0, Ordering::SeqCst, Ordering::SeqCst)
                            .is_ok()
                        {
                            let _ = save_widget_bounds(&app);
                        }
                    }
                    if now.saturating_sub(last) >= 5000 {
                        if let Err(e) = tick(&app) {
                            eprintln!("Reminder: {e}");
                        }
                        last = now;
                    }
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
            Ok(())
        });
    match builder.build(context) {
        Ok(app) => app.run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, .. } = event {
                if !state(app).quitting.load(Ordering::SeqCst) {
                    api.prevent_exit();
                }
            }
        }),
        Err(e) => {
            #[cfg(windows)]
            unsafe {
                use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR};
                let text: Vec<u16> = format!("工作看板启动失败：{e}")
                    .encode_utf16()
                    .chain(Some(0))
                    .collect();
                let title: Vec<u16> = "工作看板".encode_utf16().chain(Some(0)).collect();
                MessageBoxW(
                    std::ptr::null_mut(),
                    text.as_ptr(),
                    title.as_ptr(),
                    MB_ICONERROR,
                );
            }
            eprintln!("{e}");
            std::process::exit(1);
        }
    }
}

#[cfg(windows)]
fn install_windows_events(app: &AppHandle) -> Result<()> {
    use std::sync::OnceLock;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        System::RemoteDesktop::{WTSRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION},
        UI::{
            Shell::{DefSubclassProc, SetWindowSubclass},
            WindowsAndMessaging::{
                WM_DISPLAYCHANGE, WM_POWERBROADCAST, WM_WTSSESSION_CHANGE, WTS_SESSION_LOCK,
                WTS_SESSION_UNLOCK,
            },
        },
    };
    static APP: OnceLock<AppHandle> = OnceLock::new();
    let _ = APP.set(app.clone());
    unsafe extern "system" fn proc(
        hwnd: HWND,
        msg: u32,
        w: WPARAM,
        l: LPARAM,
        _id: usize,
        _data: usize,
    ) -> LRESULT {
        if let Some(app) = APP.get() {
            if msg == WM_WTSSESSION_CHANGE {
                if w as u32 == WTS_SESSION_LOCK {
                    apply_session_lock(app, true);
                } else if w as u32 == WTS_SESSION_UNLOCK {
                    let app = app.clone();
                    std::thread::spawn(move || {
                        apply_session_lock(&app, false);
                        let _ = tick(&app);
                    });
                }
            } else if msg == WM_DISPLAYCHANGE || (msg == WM_POWERBROADCAST && (w == 7 || w == 18)) {
                let app = app.clone();
                std::thread::spawn(move || {
                    let _ = position_widget(&app);
                    let _ = tick(&app);
                });
            }
        }
        unsafe { DefSubclassProc(hwnd, msg, w, l) }
    }
    let w = app.get_webview_window("main").ok_or("主窗口不存在")?;
    let hwnd = w.hwnd().map_err(err)?;
    unsafe {
        if SetWindowSubclass(hwnd.0 as _, Some(proc), 1, 0) == 0 {
            return Err(format!(
                "无法注册窗口事件：{}",
                std::io::Error::last_os_error()
            ));
        }
        if WTSRegisterSessionNotification(hwnd.0 as _, NOTIFY_FOR_THIS_SESSION) == 0 {
            return Err(format!(
                "无法注册锁屏事件：{}",
                std::io::Error::last_os_error()
            ));
        }
    }
    Ok(())
}
#[cfg(not(windows))]
fn install_windows_events(_: &AppHandle) -> Result<()> {
    Ok(())
}
