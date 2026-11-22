//! Mises à jour du launcher (moteur : `pl_engine::update`).
//!
//! Comme l'ancien launcher :
//! - au démarrage, une mise à jour trouvée est installée tout de suite sous
//!   Windows ; sur Mac et Linux, le joueur reçoit un bouton de téléchargement ;
//! - ensuite, nouvelle vérification toutes les 10 minutes, avec une
//!   notification (une seule fois par version).
//!
//! Jamais pendant une partie. Désactivé en développement et avec
//! `PL_NO_UPDATE=1`.

use std::{sync::Mutex, time::Duration};

use pl_engine::update::{self, Update};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{play::notify, state::AppState};

const CHECK_EVERY: Duration = Duration::from_secs(10 * 60);

#[derive(Default)]
pub struct UpdaterState {
    available: Mutex<Option<Update>>,
    notified: Mutex<Option<String>>,
}

fn enabled() -> bool {
    !cfg!(debug_assertions) && std::env::var_os("PL_NO_UPDATE").is_none()
}

fn api() -> String {
    std::env::var("PL_UPDATE_API").unwrap_or_else(|_| "https://api.github.com".into())
}

fn current_version(app: &AppHandle) -> String {
    app.package_info().version.to_string()
}

#[derive(Clone, Serialize)]
pub struct UpdateView {
    version: String,
    notes: String,
    size_mb: f64,
    /// `true` : installation automatique (Windows). Sinon téléchargement manuel.
    install: bool,
}

fn view(update: &Update) -> UpdateView {
    UpdateView {
        version: update.version.clone(),
        notes: update.notes.clone(),
        size_mb: (update.size as f64 / 1_048_576.0 * 10.0).round() / 10.0,
        install: cfg!(windows),
    }
}

async fn find(app: &AppHandle) -> Option<Update> {
    if !enabled() {
        return None;
    }
    let state = app.state::<AppState>();
    match update::check(&state.ctx.client, &api(), &current_version(app)).await {
        Ok(found) => {
            *app.state::<UpdaterState>().available.lock().unwrap() = found.clone();
            found
        }
        Err(e) => {
            // Pas de réseau, GitHub indisponible, signature refusée : on joue quand même.
            tracing::warn!("mise à jour : {e:#}");
            None
        }
    }
}

/// Vérification au démarrage (écran d'accueil du launcher).
#[tauri::command]
pub async fn check_update(app: AppHandle) -> Option<UpdateView> {
    find(&app).await.as_ref().map(view)
}

#[derive(Clone, Serialize)]
struct DownloadProgress {
    done: u64,
    total: u64,
}

/// Installe la mise à jour trouvée : téléchargement vérifié, puis
/// l'installateur prend le relais (`--update`) et le launcher se ferme.
/// Sur Mac et Linux : ouvre le téléchargement dans le navigateur.
#[tauri::command]
pub async fn apply_update(app: AppHandle, state: State<'_, AppState>, us: State<'_, UpdaterState>) -> Result<(), String> {
    if !state.running.lock().unwrap().is_empty() {
        return Err("une partie est en cours : la mise à jour se fera à la fermeture du jeu".into());
    }
    let Some(found) = us.available.lock().unwrap().clone() else {
        return Err("aucune mise à jour disponible".into());
    };
    if !cfg!(windows) {
        use tauri_plugin_opener::OpenerExt;
        return app.opener().open_url(&found.url, None::<&str>).map_err(|e| e.to_string());
    }
    let dir = std::env::temp_dir().join("PatateLand-update");
    let handle = app.clone();
    let installer = update::download(&state.ctx.client, &found, &dir, move |done, total| {
        let _ = handle.emit("update-progress", DownloadProgress { done, total });
    })
    .await
    .map_err(|e| format!("{e:#}"))?;
    std::process::Command::new(&installer)
        .arg("--update")
        .spawn()
        .map_err(|e| format!("lancement de l'installateur : {e}"))?;
    app.exit(0);
    Ok(())
}

/// Tâche de fond : nouvelle vérification toutes les 10 minutes.
pub async fn watch(app: AppHandle) {
    loop {
        tokio::time::sleep(CHECK_EVERY).await;
        let Some(found) = find(&app).await else { continue };
        let us = app.state::<UpdaterState>();
        let first_time = us.notified.lock().unwrap().replace(found.version.clone()).as_deref() != Some(found.version.as_str());
        if first_time {
            notify(&app, "PatateLand - Mise à jour disponible !", &format!("La version {} est prête. Relance le launcher pour l'installer.", found.version));
        }
        let _ = app.emit("update-available", view(&found));
    }
}
