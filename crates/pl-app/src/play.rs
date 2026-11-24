//! Lancement d'une partie, depuis l'interface ou depuis le menu de l'icône.
//!
//! Comme l'ancien launcher : notifications Windows (lancement, démarrage,
//! erreur), progression dans la barre des tâches, console de jeu si le
//! joueur l'a activée. En plus : la fenêtre principale est fermée pendant le
//! jeu pour libérer sa mémoire.

use std::{sync::atomic::Ordering, time::Duration};

use pl_engine::{
    game::{self, Event, Plan, RunOptions},
    settings,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, window::ProgressBarState, window::ProgressBarStatus};

use crate::{state::{AppState, allowed}, window};

#[derive(Clone, Serialize)]
struct ProgressView {
    done: u64,
    total: u64,
    /// Fichiers déjà vérifiés / à vérifier (étape « Vérification »).
    checked_done: u64,
    checked_total: u64,
    files_done: u64,
    files_total: u64,
}

#[derive(Clone, Serialize)]
struct ConsoleEvent {
    instance: String,
    event: Event,
}

#[derive(Clone, Serialize)]
struct GameLog {
    instance: String,
    line: String,
}

/// Notification du système ; un clic rouvre le launcher (voir notify.rs).
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    crate::notify::show(app, title, body, crate::notify::OnClick::Open);
}

fn set_taskbar_progress(app: &AppHandle, progress: Option<u64>) {
    if let Some(w) = app.get_webview_window(window::MAIN) {
        let state = match progress {
            Some(p) => ProgressBarState { status: Some(ProgressBarStatus::Normal), progress: Some(p) },
            None => ProgressBarState { status: Some(ProgressBarStatus::None), progress: None },
        };
        let _ = w.set_progress_bar(state);
    }
}

/// Lance `instance` (ou l'instance sélectionnée). Les vérifications rapides
/// sont faites ici ; l'installation et le jeu tournent en tâche de fond.
pub async fn start(app: AppHandle, instance: Option<String>) -> Result<(), String> {
    let state = app.state::<AppState>();
    let settings = state.settings.lock().unwrap().clone();
    let name = instance.or_else(|| settings.selected_instance.clone()).ok_or("aucune instance sélectionnée")?;
    let info = state
        .remote
        .read()
        .await
        .instances
        .iter()
        .find(|i| i.name == name)
        .cloned()
        .ok_or("instance inconnue : serveur PatateLand injoignable ?")?;
    let account = {
        let store = state.accounts.lock().await;
        let selected = store.selected().ok_or("aucun compte : connecte-toi d'abord")?;
        if !allowed(&info, Some(&selected.name)) {
            return Err(format!("{} n'est pas autorisé sur l'instance {name}", selected.name));
        }
        let id = selected.id.clone();
        store.game_account(&id).map_err(|e| format!("{e:#}"))?
    };
    let plan = Plan::from_info(info).map_err(|e| format!("{e:#}"))?;
    if !state.running.lock().unwrap().insert(name.clone()) {
        return Err(format!("{name} est déjà en cours"));
    }
    window::refresh_tray(&app).await;
    let _ = app.emit("game-started", &name);
    notify(&app, "PatateLand", &format!("Lancement de {name}…"));

    let memory = settings.effective_memory(settings::total_memory_gb());
    let progress = &state.ctx.progress;
    for counter in [
        &progress.done_bytes,
        &progress.total_bytes,
        &progress.done_files,
        &progress.total_files,
        &progress.checked_done,
        &progress.checked_total,
    ] {
        counter.store(0, Ordering::Relaxed);
    }

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let ctx = state.ctx.clone();

        // Progression des téléchargements, lue sans verrou 4 fois par seconde.
        let ticker = {
            let (app, ctx) = (app.clone(), ctx.clone());
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                    let p = &ctx.progress;
                    let view = ProgressView {
                        done: p.done_bytes.load(Ordering::Relaxed),
                        total: p.total_bytes.load(Ordering::Relaxed),
                        checked_done: p.checked_done.load(Ordering::Relaxed),
                        checked_total: p.checked_total.load(Ordering::Relaxed),
                        files_done: p.done_files.load(Ordering::Relaxed),
                        files_total: p.total_files.load(Ordering::Relaxed),
                    };
                    if view.total > 0 && view.done < view.total {
                        set_taskbar_progress(&app, Some(view.done * 100 / view.total));
                    }
                    let _ = app.emit("progress", view);
                }
            })
        };

        let close_behavior = settings.close_behavior;
        let show_console = settings.show_console;
        let emitter = app.clone();
        let instance = name.clone();
        let emit = move |event: Event| {
            match &event {
                Event::JavaStarted { .. } => {
                    if show_console {
                        window::open_console(&emitter, &instance);
                    }
                    // Fenêtre fermée pendant le jeu pour rendre sa mémoire à
                    // Minecraft (sauf si le joueur préfère la garder).
                    if close_behavior != settings::CloseBehavior::KeepOpen {
                        if window::release_main(&emitter) {
                            notify_background_once(&emitter);
                        }
                    }
                }
                Event::MenuReached { .. } => notify(&emitter, "PatateLand", &format!("{instance} a démarré !")),
                // Fin d'un téléchargement (seulement s'il y en a eu un).
                Event::Installed { .. } => {
                    let bytes = emitter.state::<AppState>().ctx.progress.done_bytes.load(Ordering::Relaxed);
                    if bytes > 0 {
                        let mb = bytes as f64 / 1_048_576.0;
                        notify(&emitter, "PatateLand", &format!("Téléchargement terminé : {mb:.0} Mo pour {instance}."));
                    }
                }
                Event::Log { line } => {
                    let _ = emitter.emit("game-log", GameLog { instance: instance.clone(), line: line.clone() });
                }
                Event::Exited { .. } => {
                    *emitter.state::<AppState>().last_exit.lock().unwrap() = Some(event.clone());
                    window::show_main(&emitter);
                }
                _ => {}
            }
            // Consoles : le même événement avec le nom de l'instance (plusieurs
            // parties peuvent tourner en même temps).
            if matches!(event, Event::MenuReached { .. } | Event::Exited { .. }) {
                let _ = emitter.emit("console-event", ConsoleEvent { instance: instance.clone(), event: event.clone() });
            }
            let _ = emitter.emit("game", &event);
        };

        let result = async {
            let installed = game::install(&ctx, plan, &emit).await?;
            ticker.abort();
            set_taskbar_progress(&app, None);
            game::run(
                &ctx,
                &installed,
                &settings,
                account,
                RunOptions { memory_mb: (memory.min_mb(), memory.max_mb()), exit_when_ready: false },
                &emit,
            )
            .await
        }
        .await;
        ticker.abort();
        set_taskbar_progress(&app, None);
        state.running.lock().unwrap().remove(&name);
        window::refresh_tray(&app).await;
        if let Err(e) = &result {
            notify(&app, "PatateLand", &format!("Erreur au lancement de {name}."));
            window::show_main(&app);
            tracing::error!("lancement de {name} : {e:#}");
        }
        let _ = app.emit("game-finished", Finished { instance: name, error: result.as_ref().err().map(|e| format!("{e:#}")) });
    });
    Ok(())
}

#[derive(Clone, Serialize)]
struct Finished {
    instance: String,
    error: Option<String>,
}

/// Comme l'ancien launcher : une seule fois par session, on rappelle que le
/// launcher reste disponible près de l'horloge (même message qu'en réduisant).
fn notify_background_once(app: &AppHandle) {
    crate::notify::background_once(app);
}
