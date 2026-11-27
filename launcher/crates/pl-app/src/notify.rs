//! Notifications du système, comme l'ancien launcher (notifications Windows
//! avec l'icône PatateLand ; un clic rouvre le launcher).
//!
//! Windows n'affiche les notifications d'une application que si son identité
//! (AppUserModelID) est enregistrée. Le launcher l'enregistre lui-même pour
//! l'utilisateur courant (`HKCU\Software\Classes\AppUserModelId`), avec son
//! nom et son icône : sans ça, toutes les notifications étaient ignorées.

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::AppHandle;

/// Action au clic sur la notification.
#[derive(Clone)]
pub enum OnClick {
    /// Rouvre la fenêtre du launcher.
    Open,
    /// Ouvre une adresse (téléchargement d'une mise à jour sur Mac/Linux).
    #[cfg_attr(windows, allow(dead_code))]
    Url(String),
}

pub fn show(app: &AppHandle, title: &str, body: &str, click: OnClick) {
    if let Err(e) = imp::show(app, title, body, click) {
        tracing::warn!("notification impossible : {e}");
    }
}

static BACKGROUND_SHOWN: AtomicBool = AtomicBool::new(false);

/// « Le launcher tourne en arrière-plan », une seule fois par session (comme
/// l'ancien launcher), la première fois que la fenêtre passe dans le tray.
pub fn background_once(app: &AppHandle) {
    if !BACKGROUND_SHOWN.swap(true, Ordering::SeqCst) {
        show(
            app,
            "PatateLand Launcher",
            "Le launcher tourne en arrière-plan. Cliquez ici ou double-cliquez sur l'icône pour le rouvrir.",
            OnClick::Open,
        );
    }
}

/// Bouton « Envoyer une notification de test » des paramètres.
#[tauri::command]
pub fn test_notification(app: AppHandle) -> Result<(), String> {
    imp::show(&app, "PatateLand", "Les notifications fonctionnent ! Cliquez ici pour rouvrir le launcher.", OnClick::Open)
}

fn on_click(app: &AppHandle, click: &OnClick) {
    match click {
        OnClick::Open => crate::window::show_main_later(app),
        OnClick::Url(url) => {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(url, None::<&str>);
        }
    }
}

#[cfg(windows)]
mod imp {
    use std::{path::PathBuf, sync::OnceLock};

    use tauri::{AppHandle, Manager};
    use tauri_winrt_notification::{IconCrop, Sound, Toast};

    use super::OnClick;
    use crate::state::AppState;

    /// Icône des notifications, écrite dans le dossier du launcher.
    const ICON: &[u8] = include_bytes!("../icons/icon.png");

    /// Lancé depuis le dossier de compilation (développement) : Windows ne
    /// connaît pas l'application, on passe par l'identité de PowerShell.
    fn is_dev_build() -> bool {
        let Ok(exe) = std::env::current_exe() else { return true };
        exe.parent().is_some_and(|dir| {
            let dir = dir.display().to_string().replace('/', "\\");
            dir.ends_with("\\release") && dir.contains("\\target") || dir.ends_with("\\debug")
        })
    }

    /// Enregistre l'identité du launcher (une fois par session).
    fn register(app: &AppHandle) -> Option<(String, PathBuf)> {
        static DONE: OnceLock<Option<(String, PathBuf)>> = OnceLock::new();
        DONE.get_or_init(|| {
            let id = app.config().identifier.clone();
            let icon = app.state::<AppState>().data_dir.join("notification.png");
            if std::fs::read(&icon).ok().as_deref() != Some(ICON) {
                std::fs::write(&icon, ICON).ok()?;
            }
            let key = windows_registry::CURRENT_USER.create(format!(r"Software\Classes\AppUserModelId\{id}")).ok()?;
            key.set_string("DisplayName", "PatateLand").ok()?;
            key.set_string("IconUri", icon.display().to_string()).ok()?;
            Some((id, icon))
        })
        .clone()
    }

    pub fn show(app: &AppHandle, title: &str, body: &str, click: OnClick) -> Result<(), String> {
        let (id, icon) = if is_dev_build() {
            (Toast::POWERSHELL_APP_ID.to_owned(), None)
        } else {
            match register(app) {
                Some((id, icon)) => (id, Some(icon)),
                None => (Toast::POWERSHELL_APP_ID.to_owned(), None),
            }
        };
        let mut toast = Toast::new(&id).title(title).text1(body).sound(Some(Sound::Default));
        if let Some(icon) = &icon {
            toast = toast.icon(icon, IconCrop::Square, "PatateLand");
        }
        let handle = app.clone();
        toast
            .on_activated(move |_| {
                super::on_click(&handle, &click);
                Ok(())
            })
            .show()
            .map_err(|e| e.to_string())
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;
    use tauri_plugin_notification::NotificationExt;

    use super::OnClick;

    /// Mac et Linux : notification du système (le clic n'est pas transmis
    /// par le module de notifications sur ces systèmes).
    pub fn show(app: &AppHandle, title: &str, body: &str, _click: OnClick) -> Result<(), String> {
        app.notification().builder().title(title).body(body).show().map_err(|e| e.to_string())
    }
}
