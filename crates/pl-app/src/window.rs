//! Fenêtres (principale, console de jeu, connexion Microsoft) et icône de la
//! zone de notification.
//!
//! Pendant le jeu, la fenêtre principale est **détruite** (pas seulement
//! cachée) : le moteur web WebView2 libère sa mémoire et seul le moteur Rust
//! reste actif. Elle est recréée à la fin de la partie ou depuis l'icône.

use tauri::{
    AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder,
    menu::{Menu, MenuItem, PredefinedMenuItem, Submenu},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};

use crate::state::AppState;

pub const MAIN: &str = "main";
const TRAY: &str = "patateland";
const MICROSOFT_LOGIN: &str = "microsoft-login";

/// Options WebView2 par défaut de Tauri, reprises telles quelles.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// Mode léger : sans processus graphique, WebView2 utilise environ 150 Mo
/// de moins (mesuré : 266 → 117 Mo privés, fenêtre ouverte). L'interface est
/// assez simple pour un rendu par le processeur.
fn browser_args(app: &AppHandle) -> String {
    let lite = app.state::<AppState>().settings.lock().unwrap().lite_mode;
    if lite { format!("{BROWSER_ARGS} --disable-gpu") } else { BROWSER_ARGS.to_owned() }
}

/// Affiche la fenêtre principale, en la créant (ou recréant après une
/// partie) si besoin.
pub fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window(MAIN) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let Some(config) = app.config().app.windows.iter().find(|w| w.label == MAIN).cloned() else {
        tracing::error!("configuration de la fenêtre principale introuvable");
        return;
    };
    let window = WebviewWindowBuilder::from_config(app, &config).and_then(|b| {
        let b = b.additional_browser_args(&browser_args(app));
        // Mac : boutons natifs rouge/orange/vert en haut à gauche, par-dessus
        // l'interface (comme l'ancien launcher), au lieu des boutons Windows.
        #[cfg(target_os = "macos")]
        let b = b.decorations(true).title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
        b.build()
    });
    match window {
        Ok(window) => {
            let _ = window.set_focus();
        }
        Err(e) => tracing::error!("impossible d'ouvrir la fenêtre : {e}"),
    }
}

/// Ferme la fenêtre principale pour libérer la mémoire pendant le jeu.
/// Renvoie `true` si une fenêtre a été fermée.
pub fn release_main(app: &AppHandle) -> bool {
    app.get_webview_window(MAIN).is_some_and(|window| window.destroy().is_ok())
}

/// Console de jeu d'une instance (réglage « Afficher la console »), comme
/// l'ancien launcher. Elle reste ouverte même quand la fenêtre principale est
/// fermée pendant le jeu.
pub fn open_console(app: &AppHandle, instance: &str) {
    let label = format!("console-{}", instance.chars().filter(|c| c.is_ascii_alphanumeric()).collect::<String>());
    if let Some(window) = app.get_webview_window(&label) {
        let _ = window.set_focus();
        return;
    }
    let url = WebviewUrl::App(format!("console.html?instance={}", encode(instance)).into());
    let built = WebviewWindowBuilder::new(app, &label, url)
        .title(format!("PatateLand - Console {instance}"))
        .inner_size(760.0, 480.0)
        .min_inner_size(600.0, 380.0)
        .decorations(false)
        .background_color(tauri::window::Color(20, 22, 28, 255))
        .additional_browser_args(&browser_args(app))
        .build();
    if let Err(e) = built {
        tracing::warn!("console de jeu impossible à ouvrir : {e}");
    }
}

fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| if b.is_ascii_alphanumeric() { (b as char).to_string() } else { format!("%{b:02X}") })
        .collect()
}

/// Ouvre la page officielle de connexion Microsoft dans une fenêtre dédiée et
/// renvoie l'adresse de redirection finale (qui contient le code), ou `None`
/// si le joueur ferme la fenêtre.
///
/// - Le mot de passe est saisi uniquement sur la page de Microsoft.
/// - Navigation privée : aucun cookie Microsoft n'est gardé par le launcher.
/// - Cette fenêtre n'a aucune permission (capabilities limitées aux fenêtres
///   du launcher) : la page distante ne peut appeler aucune commande.
pub async fn microsoft_login(app: &AppHandle, authorize_url: &str, redirect_prefix: &'static str) -> Result<Option<String>, String> {
    if let Some(window) = app.get_webview_window(MICROSOFT_LOGIN) {
        let _ = window.set_focus();
        return Err("une connexion Microsoft est déjà en cours".into());
    }
    let url: tauri::Url = authorize_url.parse().map_err(|e| format!("adresse Microsoft invalide : {e}"))?;
    let (tx, rx) = tokio::sync::oneshot::channel::<Option<String>>();
    let tx = std::sync::Arc::new(std::sync::Mutex::new(Some(tx)));

    let on_redirect = tx.clone();
    let window = WebviewWindowBuilder::new(app, MICROSOFT_LOGIN, WebviewUrl::External(url))
        .title("Connexion Microsoft - PatateLand")
        .inner_size(520.0, 700.0)
        .center()
        .incognito(true)
        // Mêmes options que la fenêtre principale (obligatoire avec WebView2).
        .additional_browser_args(&browser_args(app))
        .on_navigation(move |url| {
            if url.as_str().starts_with(redirect_prefix) {
                if let Some(tx) = on_redirect.lock().unwrap().take() {
                    let _ = tx.send(Some(url.to_string()));
                }
                return false;
            }
            true
        })
        .build()
        .map_err(|e| format!("impossible d'ouvrir la connexion Microsoft : {e}"))?;

    let on_close = tx.clone();
    window.on_window_event(move |event| {
        if matches!(event, tauri::WindowEvent::Destroyed) {
            if let Some(tx) = on_close.lock().unwrap().take() {
                let _ = tx.send(None);
            }
        }
    });

    let redirect = rx.await.unwrap_or(None);
    if let Some(window) = app.get_webview_window(MICROSOFT_LOGIN) {
        let _ = window.destroy();
    }
    show_main(app);
    Ok(redirect)
}

// ---------- Icône de la zone de notification ----------

/// Menu de l'icône, comme celui de l'ancien launcher : ouvrir, jouer à une
/// instance (celles en cours sont signalées), réglages, déconnexion, quitter.
async fn tray_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let state = app.state::<AppState>();
    let instances: Vec<String> = {
        let remote = state.remote.read().await;
        let mut names: Vec<String> = remote.instances.iter().map(|i| i.name.clone()).collect();
        names.sort_by_key(|n| n.eq_ignore_ascii_case("event"));
        names
    };
    let running = state.running.lock().unwrap().clone();

    let play = Submenu::with_id(app, "play", "Jouer", !instances.is_empty())?;
    for name in &instances {
        let busy = running.contains(name);
        let label = if busy { format!("{name} (en cours)") } else { name.clone() };
        play.append(&MenuItem::with_id(app, format!("play:{name}"), label, !busy, None::<&str>)?)?;
    }
    Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Ouvrir PatateLand", true, None::<&str>)?,
            &play,
            &MenuItem::with_id(app, "settings", "Réglages", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "logout", "Se déconnecter", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quitter", true, None::<&str>)?,
        ],
    )
}

/// Met à jour le menu (liste des instances, parties en cours).
pub async fn refresh_tray(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    match tray_menu(app).await {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => tracing::warn!("menu de l'icône : {e}"),
    }
}

fn on_tray_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "settings" => {
            show_main(app);
            let _ = app.emit("open-settings", ());
        }
        "logout" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                // Comme l'ancien launcher : retire le compte sélectionné (action
                // explicite du joueur).
                let state = app.state::<AppState>();
                let mut store = state.accounts.lock().await;
                if let Some(id) = store.selected().map(|a| a.id.clone()) {
                    store.remove(&id);
                    let _ = store.save();
                }
                drop(store);
                show_main(&app);
                let _ = app.emit("accounts-changed", ());
            });
        }
        "quit" => app.exit(0),
        other => {
            if let Some(instance) = other.strip_prefix("play:") {
                let (app, instance) = (app.clone(), instance.to_owned());
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = crate::play::start(app.clone(), Some(instance)).await {
                        crate::play::notify(&app, "PatateLand", &e);
                    }
                });
            }
        }
    }
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(app, &[&MenuItem::with_id(app, "open", "Ouvrir PatateLand", true, None::<&str>)?])?;
    let mut builder = TrayIconBuilder::with_id(TRAY)
        .tooltip("PatateLand")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| on_tray_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
