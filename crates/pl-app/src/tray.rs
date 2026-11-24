//! Menu de l'icône (zone de notification) : petite fenêtre au style du
//! launcher, comme l'ancien (`trayMenu.html` / `windows/trayMenu.js`), au lieu
//! du menu natif de Windows.
//!
//! - clic gauche ou droit sur l'icône : ouvre/ferme le menu, placé juste
//!   au-dessus de l'icône ;
//! - double-clic : ouvre le launcher ;
//! - le menu se ferme au clic ailleurs ou avec Échap.
//!
//! La fenêtre n'est créée qu'à la première ouverture, puis détruite après
//! deux minutes sans servir : aucune mémoire utilisée le reste du temps.
//! Linux ne transmet pas les clics sur l'icône : le menu natif y est gardé.

use std::{sync::Mutex, time::Duration};

use serde::Serialize;
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, Rect, Size, State, WebviewUrl,
    WebviewWindowBuilder, WindowEvent, window::Color,
};

use crate::state::AppState;

pub const POPUP: &str = "tray-menu";
const WIDTH: f64 = 240.0;
const IDLE_DESTROY: Duration = Duration::from_secs(120);

/// Position et taille de l'icône (pixels physiques) au dernier clic.
static ANCHOR: Mutex<Option<(f64, f64, f64, f64)>> = Mutex::new(None);
/// Dernière fermeture par perte du focus. Un clic sur l'icône pour fermer le
/// menu le fait d'abord perdre le focus : sans ce délai, il se rouvrait.
static LAST_BLUR: Mutex<Option<std::time::Instant>> = Mutex::new(None);

fn rect_to_physical(rect: &Rect) -> (f64, f64, f64, f64) {
    let (x, y) = match rect.position {
        Position::Physical(p) => (p.x as f64, p.y as f64),
        Position::Logical(p) => (p.x, p.y),
    };
    let (w, h) = match rect.size {
        Size::Physical(s) => (s.width as f64, s.height as f64),
        Size::Logical(s) => (s.width, s.height),
    };
    (x, y, w, h)
}

fn is_light(app: &AppHandle) -> bool {
    use pl_engine::settings::Theme;
    match app.state::<AppState>().settings.lock().unwrap().theme {
        Theme::Light => true,
        Theme::Dark => false,
        // « auto » : thème du système.
        Theme::Auto => app.webview_windows().values().next().and_then(|w| w.theme().ok()) == Some(tauri::Theme::Light),
    }
}

/// Ouvre ou ferme le menu.
pub fn toggle(app: &AppHandle, rect: &Rect) {
    tracing::debug!("clic sur l'icône");
    if let Some(window) = app.get_webview_window(POPUP) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
            return;
        }
    }
    if LAST_BLUR.lock().unwrap().is_some_and(|t| t.elapsed() < Duration::from_millis(300)) {
        return;
    }
    *ANCHOR.lock().unwrap() = Some(rect_to_physical(rect));
    match app.get_webview_window(POPUP) {
        // Déjà créée : le menu se redessine puis demande à être affiché
        // (commande `tray_resize`).
        Some(window) => {
            let _ = window.emit("tray-refresh", ());
        }
        // Création sur un fil séparé : dans le gestionnaire du clic, elle
        // bloquerait tout le launcher sous Windows (clic droit sans effet).
        None => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move { create(&app) });
        }
    }
}

pub fn hide(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(POPUP) {
        let _ = window.hide();
    }
}

fn create(app: &AppHandle) {
    let background = if is_light(app) { Color(0xf2, 0xf2, 0xf2, 0xff) } else { Color(0x1b, 0x1d, 0x24, 0xff) };
    let built = WebviewWindowBuilder::new(app, POPUP, WebviewUrl::App("tray.html".into()))
        .title("PatateLand - Menu")
        .inner_size(WIDTH, 260.0)
        .decorations(false)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .skip_taskbar(true)
        .always_on_top(true)
        .shadow(true)
        .visible(false)
        .background_color(background)
        // Mêmes réglages WebView2 que les autres fenêtres : sans eux, WebView2
        // refusait de créer le menu (clic droit sans effet).
        .additional_browser_args(&crate::window::browser_args(app))
        .build();
    let window = match built {
        Ok(window) => window,
        Err(e) => {
            // Le clic ne doit jamais rester sans effet : on ouvre le launcher.
            tracing::error!("menu de l'icône impossible à créer : {e}");
            crate::window::show_main(app);
            return;
        }
    };
    tracing::info!("menu de l'icône créé");
    let app = app.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::Focused(false) = event {
            *LAST_BLUR.lock().unwrap() = Some(std::time::Instant::now());
            hide(&app);
            // Détruite si elle ne resert pas dans les deux minutes.
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(IDLE_DESTROY).await;
                if let Some(window) = app.get_webview_window(POPUP) {
                    if !window.is_visible().unwrap_or(true) {
                        let _ = window.destroy();
                    }
                }
            });
        }
    });
}

#[derive(Serialize)]
pub struct TrayInstance {
    name: String,
    running: bool,
}

#[derive(Serialize)]
pub struct TrayView {
    instances: Vec<TrayInstance>,
    light: bool,
}

/// Contenu du menu : instances (l'Event en dernier, comme partout) et thème.
#[tauri::command]
pub async fn tray_state(app: AppHandle, state: State<'_, AppState>) -> Result<TrayView, String> {
    let mut names: Vec<String> = state.remote.read().await.instances.iter().map(|i| i.name.clone()).collect();
    names.sort_by_key(|n| n.eq_ignore_ascii_case("event"));
    let running = state.running.lock().unwrap().clone();
    Ok(TrayView {
        instances: names.into_iter().map(|name| TrayInstance { running: running.contains(&name), name }).collect(),
        light: is_light(&app),
    })
}

/// Le menu a mesuré sa hauteur : la fenêtre prend cette taille et se place
/// au-dessus de l'icône, dans les limites de l'écran (comme l'ancien).
#[tauri::command]
pub fn tray_resize(app: AppHandle, height: f64) {
    let Some(window) = app.get_webview_window(POPUP) else { return };
    tracing::debug!("menu de l'icône : hauteur {height}");
    let height = height.clamp(40.0, 600.0).ceil() + 4.0;
    let scale = window.scale_factor().unwrap_or(1.0);
    let _ = window.set_size(LogicalSize::new(WIDTH, height));
    let (pw, ph) = (WIDTH * scale, height * scale);

    let anchor = *ANCHOR.lock().unwrap();
    let monitor = anchor
        .and_then(|(x, y, _, _)| app.monitor_from_point(x, y).ok().flatten())
        .or_else(|| app.primary_monitor().ok().flatten());
    let (mut x, mut y) = match anchor {
        Some((ax, ay, aw, _)) => (ax + aw - pw, ay - ph - 4.0 * scale),
        None => (0.0, 0.0),
    };
    if let Some(monitor) = monitor {
        let area = monitor.work_area();
        let (left, top) = (area.position.x as f64, area.position.y as f64);
        let (right, bottom) = (left + area.size.width as f64, top + area.size.height as f64);
        if anchor.is_none() {
            (x, y) = (right - pw - 12.0 * scale, bottom - ph - 12.0 * scale);
        }
        x = x.clamp(left + 4.0, (right - pw - 4.0).max(left + 4.0));
        y = y.clamp(top + 4.0, (bottom - ph - 4.0).max(top + 4.0));
    }
    let _ = window.set_position(PhysicalPosition::new(x.round() as i32, y.round() as i32));
    if !window.is_visible().unwrap_or(false) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Action choisie dans le menu (mêmes actions que l'ancien).
#[tauri::command]
pub fn tray_action(app: AppHandle, action: String) {
    hide(&app);
    crate::window::tray_action(&app, &action);
}

#[tauri::command]
pub fn tray_hide(app: AppHandle) {
    hide(&app);
}
