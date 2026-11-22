//! Désinstallation (`uninstall.exe --uninstall`), avec des fenêtres Windows
//! simples : pas besoin de WebView2 pour désinstaller.
//!
//! Supprimé : le launcher, ses raccourcis, son démarrage automatique et son
//! entrée dans « Applications installées ». Conservé : les comptes, les
//! réglages, les mondes et les instances (dans `%APPDATA%`).

use crate::win::{self, Answer, LAUNCHER_EXE, PRODUCT, UNINSTALLER_EXE};
use std::path::Path;

pub fn run(quiet: bool) -> i32 {
    let Some(dir) = std::env::current_exe().ok().and_then(|e| e.parent().map(Path::to_path_buf)) else {
        return 1;
    };
    let launcher = dir.join(LAUNCHER_EXE);

    if !quiet {
        let question = format!(
            "Désinstaller {PRODUCT} ?\n\nTes comptes, tes réglages et tes mondes sont conservés. \
             L'ancien launcher PatateLand n'est pas concerné."
        );
        if let Answer::No = win::ask(&question) {
            return 0;
        }
    }
    while win::is_running(&launcher) {
        if quiet {
            return 2;
        }
        let retry = win::ask(&format!(
            "{PRODUCT} est ouvert.\n\nFerme-le (pense à l'icône près de l'horloge), puis clique sur Oui pour continuer."
        ));
        if let Answer::No = retry {
            return 0;
        }
    }

    // « PatateLand.lnk » appartient à l'ancien launcher s'il est encore là.
    let mut links: Vec<_> = win::shortcuts(win::SHORTCUT_BESIDE_OLD).into_iter().flatten().collect();
    if win::electron_install().is_none() {
        links.extend(win::shortcuts(PRODUCT).into_iter().flatten());
    }
    for link in links {
        let _ = std::fs::remove_file(link);
    }
    let _ = win::set_autostart(&launcher, false);
    win::unregister_uninstall();
    for name in [LAUNCHER_EXE.to_string(), format!("{LAUNCHER_EXE}.part"), format!("{UNINSTALLER_EXE}.part")] {
        let _ = std::fs::remove_file(dir.join(name));
    }
    remove_self_later(&dir);

    if !quiet {
        win::info(&format!("{PRODUCT} a été désinstallé."));
    }
    0
}

/// Un programme ne peut pas supprimer son propre fichier pendant qu'il
/// tourne : une invite de commandes invisible s'en charge deux secondes plus
/// tard, puis retire le dossier **s'il est vide** (jamais de suppression
/// récursive).
fn remove_self_later(dir: &Path) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let dir_text = dir.display().to_string();
    // Caractères interprétés par cmd : on laisse alors uninstall.exe en place.
    if dir_text.contains(['%', '"', '^', '!']) {
        return;
    }
    let uninstaller = dir.join(UNINSTALLER_EXE).display().to_string();
    let line = format!("/d /c ping -n 3 127.0.0.1 >nul & del /f /q \"{uninstaller}\" & rmdir \"{dir_text}\"");
    let _ = std::process::Command::new("cmd.exe")
        .raw_arg(line)
        .current_dir(std::env::temp_dir())
        .creation_flags(CREATE_NO_WINDOW)
        .spawn();
}
