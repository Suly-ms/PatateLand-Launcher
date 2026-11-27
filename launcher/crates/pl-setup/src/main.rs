//! Installateur PatateLand : la même interface que le launcher, sans
//! droits administrateur. Avec `--uninstall`, désinstalle.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod install;
mod overlay;
mod uninstall;
mod win;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--uninstall") {
        std::process::exit(uninstall::run(args.iter().any(|a| a == "--quiet")));
    }
    if !win::webview2_installed() && !install_webview2() {
        return;
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(install::SetupState::default())
        .invoke_handler(tauri::generate_handler![
            install::info,
            install::pick_dir,
            install::install,
            install::finish,
            install::quit,
            install::minimize,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| win::error(&format!("L'installateur n'a pas pu démarrer : {e}")));
}

/// Windows 10 sans WebView2 : on propose le programme officiel de Microsoft,
/// inclus dans l'installateur. Sinon, message clair.
fn install_webview2() -> bool {
    let bootstrapper = std::env::current_exe()
        .ok()
        .and_then(|exe| overlay::read(&exe).ok().flatten().and_then(|o| o.webview2(&exe).ok().flatten()));
    let Some(bytes) = bootstrapper else {
        win::error("Le composant Microsoft WebView2 est nécessaire mais absent de ce PC. Installe « Microsoft Edge WebView2 Runtime » depuis le site de Microsoft, puis relance cet installateur.");
        return false;
    };
    let question = "PatateLand a besoin du composant Microsoft WebView2 (celui de Microsoft Edge), absent de ce PC.\n\n\
                    L'installer maintenant ? Il sera téléchargé depuis Microsoft.";
    if let win::Answer::No = win::ask(question) {
        return false;
    }
    let path = std::env::temp_dir().join("PatateLand-MicrosoftEdgeWebview2Setup.exe");
    let ok = std::fs::write(&path, bytes).is_ok()
        && std::process::Command::new(&path).arg("/install").status().is_ok_and(|s| s.success());
    let _ = std::fs::remove_file(&path);
    if !ok || !win::webview2_installed() {
        win::error("L'installation de WebView2 a échoué. Vérifie ta connexion Internet, puis relance l'installateur.");
        return false;
    }
    true
}
