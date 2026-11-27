//! Launcher PatateLand : fenêtre Tauri au-dessus du moteur `pl-engine`.
//!
//! Toute la logique est dans le moteur ; ce module ne fait que relier
//! l'interface (dossier `ui/`) aux fonctions du moteur.

// Pas de console noire derrière la fenêtre en version finale.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod extras;
mod friends;
mod notify;
mod play;
mod state;
mod tray;
mod updater;
mod window;

use tauri::{Manager, RunEvent};

/// Argument ajouté quand Windows lance le launcher à l'ouverture de session.
const AUTOSTART_ARG: &str = "--autostart";

/// Journal du launcher : `<dossier du launcher>/logs/launcher.log`, réécrit à
/// chaque démarrage (taille limitée). Sert à diagnostiquer un problème chez
/// un joueur sans avoir accès à son écran. Aucun jeton n'y est écrit.
fn log_file() -> Option<std::fs::File> {
    let dir = std::env::var_os("PL_DATA").map(std::path::PathBuf::from).unwrap_or_else(pl_engine::paths::launcher_data_dir).join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    std::fs::File::create(dir.join("launcher.log")).ok()
}

fn main() {
    let filter = || {
        tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info,reqwest=warn,hyper=warn".into())
    };
    match log_file() {
        Some(file) => tracing_subscriber::fmt()
            .with_env_filter(filter())
            .with_target(false)
            .with_ansi(false)
            .with_writer(std::sync::Mutex::new(file))
            .init(),
        None => tracing_subscriber::fmt().with_env_filter(filter()).with_target(false).init(),
    }
    tracing::info!("PatateLand {} démarré", env!("CARGO_PKG_VERSION"));

    let state = match state::AppState::new() {
        Ok(state) => state,
        Err(e) => {
            eprintln!("Impossible de démarrer le launcher : {e:#}");
            std::process::exit(1);
        }
    };
    tracing::info!("dossier de jeu : {}", state.ctx.paths.root().display());
    tracing::info!("dossier du launcher : {}", state.data_dir.display());

    tauri::Builder::default()
        // Un second lancement remet simplement la fenêtre existante au premier plan.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| window::show_main_later(app)))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_ARG]),
        ))
        .manage(state)
        .manage(friends::FriendsState::default())
        .manage(updater::UpdaterState::default())
        .setup(|app| {
            window::create_tray(app.handle())?;
            // « Démarrer réduit » : lancé avec Windows, le launcher reste
            // dans la zone de notification, sans fenêtre (donc sans WebView2).
            let autostarted = std::env::args().any(|a| a == AUTOSTART_ARG);
            let start_minimized = app.state::<state::AppState>().settings.lock().unwrap().start_minimized;
            if !(autostarted && start_minimized) {
                // Créée ici et non par la configuration : les options WebView2
                // dépendent du mode léger.
                window::show_main(app.handle());
            }
            // Menu de l'icône avec les instances déjà connues (copie locale).
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move { window::refresh_tray(&handle).await });
            // Amis : présence, non-lus et notifications, même fenêtre fermée.
            tauri::async_runtime::spawn(friends::poll(app.handle().clone()));
            // Mises à jour : nouvelle vérification toutes les 10 minutes.
            tauri::async_runtime::spawn(updater::watch(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::bootstrap,
            commands::take_last_exit,
            commands::refresh_accounts,
            commands::add_offline,
            commands::login_azauth,
            commands::login_microsoft,
            commands::select_account,
            commands::remove_account,
            commands::instances,
            commands::select_instance,
            commands::update_settings,
            commands::news,
            commands::server_status,
            commands::play,
            commands::packs_list,
            commands::packs_import,
            commands::packs_remove,
            commands::open_instance_folder,
            commands::open_url,
            commands::window_minimize,
            commands::window_toggle_maximize,
            commands::window_close,
            extras::pick_java,
            extras::reset_java,
            extras::set_auto_launch,
            extras::auto_launch_enabled,
            extras::dismiss_review,
            extras::storage_overview,
            extras::clear_logs,
            extras::clear_cache,
            extras::quarantine_restore,
            extras::crash_report_read,
            extras::crash_report_open,
            friends::friends,
            friends::friends_notify,
            updater::check_update,
            tray::tray_state,
            notify::test_notification,
            tray::tray_resize,
            tray::tray_action,
            tray::tray_hide,
            updater::apply_update,
        ])
        .build(tauri::generate_context!())
        .expect("erreur au lancement de l'application")
        .run(|app, event| {
            // Fenêtre fermée par le launcher (pendant une partie) ou démarrage
            // réduit : l'application continue (moteur + icône). Une fermeture
            // demandée par le joueur (bouton Fermer, menu Quitter) porte un
            // code et n'est pas bloquée.
            if let RunEvent::ExitRequested { code: None, api, .. } = event {
                let state = app.state::<state::AppState>();
                if !state.running.lock().unwrap().is_empty() {
                    api.prevent_exit();
                }
            }
        });
}
