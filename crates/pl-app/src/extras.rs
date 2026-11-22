//! Fonctions de l'ancien launcher reprises : Java personnalisé, lancement
//! avec Windows, stockage (avec la quarantaine), bandeau d'avis.

use pl_engine::{quarantine::Quarantine, settings::Settings, storage};
use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;

use crate::state::AppState;

type CmdResult<T> = Result<T, String>;

fn save(state: &AppState, update: impl FnOnce(&mut Settings)) -> CmdResult<Settings> {
    let mut settings = state.settings.lock().unwrap().clone();
    update(&mut settings);
    settings.save(&state.settings_path()).map_err(|e| format!("{e:#}"))?;
    *state.settings.lock().unwrap() = settings.clone();
    Ok(settings)
}

/// Java choisi par le joueur (boîte de dialogue ouverte par le launcher).
/// Comme l'ancien launcher, seul un exécutable `java` ou `javaw` est accepté.
#[tauri::command]
pub async fn pick_java(app: AppHandle, state: State<'_, AppState>) -> CmdResult<Settings> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    let dialog = app.dialog().file();
    // Sous Mac et Linux, l'exécutable java n'a pas d'extension.
    let dialog = if cfg!(windows) { dialog.add_filter("Java (java.exe, javaw.exe)", &["exe"]) } else { dialog };
    dialog.pick_file(move |file| {
        let _ = tx.send(file);
    });
    let Some(file) = rx.await.map_err(|e| e.to_string())? else {
        return Ok(state.settings.lock().unwrap().clone());
    };
    let path = file.into_path().map_err(|e| e.to_string())?;
    let stem = path.file_stem().map(|s| s.to_string_lossy().to_lowercase()).unwrap_or_default();
    if stem != "java" && stem != "javaw" {
        return Err(if cfg!(windows) { "le fichier doit être java.exe ou javaw.exe" } else { "le fichier doit être l'exécutable java" }.into());
    }
    save(&state, |s| s.java_path = Some(path))
}

#[tauri::command]
pub fn reset_java(state: State<'_, AppState>) -> CmdResult<Settings> {
    save(&state, |s| s.java_path = None)
}

/// Lancement avec Windows. L'état affiché est celui réellement enregistré
/// dans Windows (correction d'un défaut de l'ancien launcher, qui affichait
/// sa propre copie du réglage).
#[tauri::command]
pub fn set_auto_launch(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> CmdResult<Settings> {
    let autolaunch = app.autolaunch();
    let result = if enabled { autolaunch.enable() } else { autolaunch.disable() };
    result.map_err(|e| format!("Windows a refusé le réglage : {e}"))?;
    let real = autolaunch.is_enabled().unwrap_or(false);
    save(&state, |s| s.auto_launch = real)
}

#[tauri::command]
pub fn auto_launch_enabled(app: AppHandle) -> bool {
    app.autolaunch().is_enabled().unwrap_or(false)
}

#[tauri::command]
pub fn dismiss_review(state: State<'_, AppState>, account: String) -> CmdResult<Settings> {
    save(&state, |s| {
        if !s.review_dismissed_accounts.contains(&account) {
            s.review_dismissed_accounts.push(account);
        }
    })
}

#[derive(Serialize)]
pub struct StorageView {
    overview: storage::Overview,
    total: u64,
    quarantine: Vec<pl_engine::quarantine::Entry>,
}

fn quarantine(state: &AppState) -> Quarantine {
    Quarantine::new(state.ctx.paths.state_dir().join("quarantine"))
}

#[tauri::command]
pub async fn storage_overview(state: State<'_, AppState>) -> CmdResult<StorageView> {
    let overview = storage::overview(&state.ctx.paths, &state.data_dir).await.map_err(|e| format!("{e:#}"))?;
    Ok(StorageView {
        total: overview.total(),
        overview,
        quarantine: quarantine(&state).list().map_err(|e| format!("{e:#}"))?,
    })
}

fn ensure_idle(state: &AppState) -> CmdResult<()> {
    if state.running.lock().unwrap().is_empty() {
        Ok(())
    } else {
        Err("ferme d'abord le jeu en cours".into())
    }
}

/// Vide les logs de l'instance sélectionnée. Renvoie le nombre de fichiers
/// en cours d'utilisation laissés en place.
#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>) -> CmdResult<usize> {
    ensure_idle(&state)?;
    let instance = state.settings.lock().unwrap().selected_instance.clone().ok_or("aucune instance sélectionnée")?;
    Ok(storage::clear_logs(&state.ctx.paths, &instance))
}

/// Vide le cache Minecraft (assets, bibliothèques, versions).
#[tauri::command]
pub fn clear_cache(state: State<'_, AppState>) -> CmdResult<usize> {
    ensure_idle(&state)?;
    Ok(storage::clear_cache(&state.ctx.paths))
}

#[tauri::command]
pub fn quarantine_restore(state: State<'_, AppState>, id: String) -> CmdResult<()> {
    let q = quarantine(&state);
    let entry = q.list().map_err(|e| format!("{e:#}"))?.into_iter().find(|e| e.id == id).ok_or("entrée inconnue")?;
    q.restore(&id, &state.ctx.paths.instance(&entry.instance)).map(|_| ()).map_err(|e| format!("{e:#}"))
}
