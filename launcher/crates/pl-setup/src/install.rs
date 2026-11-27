//! Installation : commandes appelées par l'interface.
//!
//! Seuls deux fichiers sont écrits dans le dossier choisi
//! (`PatateLand.exe` et `uninstall.exe`). Les comptes, réglages et
//! instances restent dans `%APPDATA%` et ne sont jamais touchés, sauf le
//! réglage « mode d'affichage » si le joueur le choisit ici.

use crate::overlay::{self, Overlay};
use crate::win::{self, LAUNCHER_EXE, PRODUCT, UNINSTALLER_EXE};
use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};
use std::fs::File;
use std::io::BufWriter;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;

#[derive(Default)]
pub struct SetupState {
    pub installing: AtomicBool,
    pub installed: Mutex<Option<PathBuf>>,
}

type CmdResult<T> = Result<T, String>;

fn err(e: anyhow::Error) -> String {
    format!("{e:#}")
}

fn current_exe() -> Result<PathBuf> {
    std::env::current_exe().context("chemin de l'installateur introuvable")
}

/// Le launcher est toujours installé dans un sous-dossier « PatateLand »
/// du dossier choisi : la désinstallation ne supprime ainsi jamais un dossier
/// qui contient autre chose.
pub fn normalize_dir(picked: &Path) -> PathBuf {
    if picked.file_name().is_some_and(|n| n.eq_ignore_ascii_case(PRODUCT)) {
        picked.to_path_buf()
    } else {
        picked.join(PRODUCT)
    }
}

#[derive(Serialize)]
pub struct SetupInfo {
    version: String,
    /// `false` : installateur fabriqué sans le launcher (développement).
    complete: bool,
    download_mb: f64,
    disk_mb: f64,
    dir: String,
    update: bool,
    previous_version: Option<String>,
    desktop: bool,
    start_menu: bool,
    autostart: bool,
    lite: bool,
    /// Version de l'ancien launcher (Electron) s'il est installé.
    old_launcher: Option<String>,
    /// Lancé par une mise à jour (ancien launcher : `--updated`, nouveau :
    /// `--update`) : installation sans clic, puis relance du launcher.
    auto: bool,
}

/// Mise à jour automatique (voir [`SetupInfo::auto`]).
pub fn auto_mode() -> bool {
    std::env::args().any(|a| a == "--updated" || a == "--update")
}

fn mb(bytes: u64) -> f64 {
    (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0
}

#[tauri::command]
pub fn info() -> CmdResult<SetupInfo> {
    let exe = current_exe().map_err(err)?;
    let overlay = overlay::read(&exe).map_err(err)?;
    let size = std::fs::metadata(&exe).map(|m| m.len()).unwrap_or(0);
    let existing = win::existing_install();
    let lite = read_settings().and_then(|s| s.get("lite_mode").and_then(|v| v.as_bool())).unwrap_or(false);
    Ok(SetupInfo {
        version: overlay.as_ref().map(|o| o.footer.version.clone()).unwrap_or_default(),
        complete: overlay.is_some(),
        download_mb: mb(size),
        disk_mb: overlay.as_ref().map_or(0.0, |o| mb(o.footer.raw_len + o.stub_len)),
        dir: existing.as_ref().map_or_else(win::default_install_dir, |e| e.dir.clone()).display().to_string(),
        update: existing.is_some(),
        previous_version: existing.as_ref().map(|e| e.version.clone()),
        // Mise à jour : on garde les choix précédents.
        desktop: existing.is_none() || win::desktop_shortcut().is_some(),
        start_menu: existing.is_none() || win::start_menu_shortcut().is_some(),
        // L'ancien launcher utilisait le même nom de démarrage automatique :
        // son choix n'est pas repris (rien n'est importé de l'ancien).
        autostart: existing.is_some() && win::autostart_enabled(),
        lite,
        old_launcher: win::electron_install().map(|o| o.version),
        auto: auto_mode(),
    })
}

#[tauri::command]
pub async fn pick_dir(app: AppHandle, current: String) -> CmdResult<Option<String>> {
    let start = PathBuf::from(&current);
    let start = start.parent().filter(|p| p.is_dir()).map(Path::to_path_buf);
    let mut dialog = app.dialog().file().set_title("Dossier d'installation de PatateLand");
    if let Some(dir) = start {
        dialog = dialog.set_directory(dir);
    }
    let picked = dialog.blocking_pick_folder();
    Ok(picked.and_then(|p| p.into_path().ok()).map(|p| normalize_dir(&p).display().to_string()))
}

#[derive(Deserialize)]
pub struct Options {
    dir: String,
    desktop: bool,
    start_menu: bool,
    autostart: bool,
    lite: bool,
    /// Désinstaller l'ancien launcher (Electron) s'il est présent.
    remove_old: bool,
}

#[derive(Clone, Serialize)]
struct Progress {
    /// 0 vérification, 1 copie, 2 ancien launcher, 3 raccourcis, 4 enregistrement.
    step: u8,
    /// Avancement global, entre 0 et 1.
    ratio: f64,
}

#[tauri::command]
pub async fn install(app: AppHandle, state: State<'_, SetupState>, options: Options) -> CmdResult<()> {
    if state.installing.swap(true, Ordering::SeqCst) {
        return Err("installation déjà en cours".into());
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let emit = |step: u8, ratio: f64| {
            let _ = handle.emit("setup-progress", Progress { step, ratio });
        };
        run(&options, emit)
    })
    .await
    .map_err(|e| e.to_string())
    .and_then(|r| r.map_err(err));
    state.installing.store(false, Ordering::SeqCst);
    let dir = result?;
    *state.installed.lock().unwrap() = Some(dir);
    Ok(())
}

fn run(options: &Options, emit: impl Fn(u8, f64)) -> Result<PathBuf> {
    // 1. Vérification
    emit(0, 0.0);
    let exe = current_exe()?;
    let Some(overlay) = overlay::read(&exe)? else {
        bail!("cet installateur ne contient pas le launcher (version de développement)");
    };
    let dir = PathBuf::from(options.dir.trim());
    if !dir.is_absolute() {
        bail!("dossier d'installation invalide");
    }
    let dir = normalize_dir(&dir);
    // Jamais dans le dossier de l'ancien launcher : son exécutable porte le même nom.
    if dir.join(win::ELECTRON_UNINSTALLER).exists() {
        bail!("ce dossier est celui de l'ancien launcher PatateLand : choisis-en un autre.");
    }
    let launcher = dir.join(LAUNCHER_EXE);
    // Mise à jour lancée par le launcher : il est en train de se fermer.
    if auto_mode() {
        for _ in 0..60 {
            if !win::is_running(&launcher) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(500));
        }
    }
    if win::is_running(&launcher) || win::legacy_running() {
        bail!("PatateLand est ouvert. Ferme-le (pense à l'icône près de l'horloge), puis clique sur Réessayer.");
    }
    emit(0, 0.05);

    // 2. Copie
    install_files(&exe, &overlay, &dir, |p| emit(1, 0.05 + p * 0.75))?;

    // 3. Ancien launcher et versions de test « PatateLand Rust ». Avant les
    // raccourcis : l'ancien a des raccourcis du même nom, que son
    // désinstallateur retire.
    emit(2, 0.82);
    if options.remove_old {
        if let Some(old) = win::electron_install() {
            win::uninstall_electron(&old)?;
        }
    }
    win::remove_legacy_install();

    // 4. Raccourcis
    emit(3, 0.88);
    // Ancien launcher gardé : ses raccourcis « PatateLand » restent, les
    // nôtres s'appellent « PatateLand (nouveau) » (jamais d'écrasement).
    let beside_old = win::electron_install().is_some();
    let name = if beside_old { win::SHORTCUT_BESIDE_OLD } else { PRODUCT };
    let [desktop, start_menu] = win::shortcuts(name);
    for (wanted, link) in [(options.desktop, desktop), (options.start_menu, start_menu)] {
        let Some(link) = link else { continue };
        if wanted {
            win::create_shortcut(&link, &launcher)?;
        } else if link.exists() {
            let _ = std::fs::remove_file(&link);
        }
    }
    // Ancien launcher parti : les raccourcis « (nouveau) » d'une bêta sont remplacés.
    if !beside_old {
        for link in win::shortcuts(win::SHORTCUT_BESIDE_OLD).into_iter().flatten() {
            let _ = std::fs::remove_file(link);
        }
    }

    // 5. Enregistrement
    emit(4, 0.94);
    win::register_uninstall(&win::Registration {
        dir: &dir,
        version: &overlay.footer.version,
        size_kb: ((overlay.footer.raw_len + overlay.stub_len) / 1024) as u32,
    })?;
    win::set_autostart(&launcher, options.autostart)?;
    write_lite_mode(&win::launcher_settings(), options.lite)?;
    emit(4, 1.0);
    Ok(dir)
}

/// Écrit le launcher (vérifié) et le désinstallateur. Chaque fichier est
/// d'abord écrit à côté puis renommé : une installation interrompue ne
/// laisse jamais un launcher à moitié copié.
pub fn install_files(setup: &Path, overlay: &Overlay, dir: &Path, progress: impl FnMut(f64)) -> Result<()> {
    std::fs::create_dir_all(dir).with_context(|| format!("création du dossier {}", dir.display()))?;

    let launcher = dir.join(LAUNCHER_EXE);
    let tmp = dir.join(format!("{LAUNCHER_EXE}.part"));
    let written = (|| {
        let mut out = BufWriter::new(File::create(&tmp)?);
        overlay.extract(setup, &mut out, progress)?;
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
        anyhow::Ok(())
    })();
    if let Err(e) = written {
        let _ = std::fs::remove_file(&tmp);
        return Err(e);
    }
    std::fs::rename(&tmp, &launcher).context("remplacement du launcher")?;

    let uninstaller = dir.join(UNINSTALLER_EXE);
    let tmp = dir.join(format!("{UNINSTALLER_EXE}.part"));
    {
        let mut out = BufWriter::new(File::create(&tmp)?);
        overlay.write_stub(setup, &mut out)?;
        out.into_inner().map_err(|e| e.into_error())?.sync_all()?;
    }
    std::fs::rename(&tmp, &uninstaller).context("remplacement du désinstallateur")?;
    Ok(())
}

fn read_settings() -> Option<serde_json::Map<String, serde_json::Value>> {
    let text = std::fs::read_to_string(win::launcher_settings()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Règle uniquement `lite_mode`, sans toucher aux autres réglages. Un
/// fichier illisible est laissé tel quel (le launcher le signalera).
pub fn write_lite_mode(path: &Path, lite: bool) -> Result<()> {
    let mut settings = match std::fs::read_to_string(path) {
        Ok(text) => match serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&text) {
            Ok(map) => map,
            Err(_) => return Ok(()),
        },
        // Pas encore de réglages : rien à écrire pour le mode normal.
        Err(_) if !lite => return Ok(()),
        Err(_) => serde_json::Map::new(),
    };
    if settings.get("lite_mode").and_then(|v| v.as_bool()) == Some(lite) {
        return Ok(());
    }
    settings.insert("lite_mode".into(), lite.into());
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("json.part");
    std::fs::write(&tmp, serde_json::to_vec_pretty(&settings)?)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[tauri::command]
pub fn finish(app: AppHandle, state: State<'_, SetupState>, launch: bool) -> CmdResult<()> {
    if launch {
        if let Some(dir) = state.installed.lock().unwrap().clone() {
            win::spawn_detached(&dir.join(LAUNCHER_EXE), &[]).map_err(err)?;
        }
    }
    app.exit(0);
    Ok(())
}

#[tauri::command]
pub fn quit(app: AppHandle, state: State<'_, SetupState>) {
    // Pas de fermeture au milieu d'une copie.
    if !state.installing.load(Ordering::SeqCst) {
        app.exit(0);
    }
}

#[tauri::command]
pub fn minimize(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.minimize();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay::Footer;
    use sha2::{Digest, Sha256};
    use std::io::Write;

    #[test]
    fn install_dir_is_always_a_dedicated_folder() {
        assert_eq!(normalize_dir(Path::new(r"D:\Jeux")), PathBuf::from(r"D:\Jeux\PatateLand"));
        assert_eq!(normalize_dir(Path::new(r"D:\Jeux\patateland")), PathBuf::from(r"D:\Jeux\patateland"));
        assert_eq!(normalize_dir(Path::new(r"C:\")), PathBuf::from(r"C:\PatateLand"));
    }

    #[test]
    fn installs_launcher_and_small_uninstaller() {
        let tmp = tempfile::tempdir().unwrap();
        let launcher: Vec<u8> = (0..200_000u32).map(|i| (i % 97) as u8).collect();
        let setup = tmp.path().join("setup.exe");
        {
            let mut f = File::create(&setup).unwrap();
            f.write_all(b"STUB").unwrap();
            let c = zstd::bulk::compress(&launcher, 3).unwrap();
            f.write_all(&c).unwrap();
            let footer = Footer {
                payload_len: c.len() as u64,
                raw_len: launcher.len() as u64,
                webview2_len: 0,
                sha256: Sha256::digest(&launcher).into(),
                version: "0.1.0".into(),
            };
            f.write_all(&footer.to_bytes()).unwrap();
        }
        let overlay = overlay::read(&setup).unwrap().unwrap();
        let dir = tmp.path().join("PatateLand");
        // Ancienne version déjà présente : elle est remplacée.
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(LAUNCHER_EXE), b"ancienne").unwrap();

        install_files(&setup, &overlay, &dir, |_| {}).unwrap();
        assert_eq!(std::fs::read(dir.join(LAUNCHER_EXE)).unwrap(), launcher);
        assert_eq!(std::fs::read(dir.join(UNINSTALLER_EXE)).unwrap(), b"STUB");
        let mut names: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
        names.sort();
        assert_eq!(names, [LAUNCHER_EXE, UNINSTALLER_EXE]);
    }

    #[test]
    fn lite_mode_keeps_other_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("PatateLand-Rust").join("settings.json");

        write_lite_mode(&path, false).unwrap();
        assert!(!path.exists(), "mode normal sans réglages : aucun fichier créé");

        write_lite_mode(&path, true).unwrap();
        std::fs::write(&path, r#"{"theme":"light","lite_mode":true,"width":1600}"#).unwrap();
        write_lite_mode(&path, false).unwrap();
        let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(v["lite_mode"], false);
        assert_eq!(v["theme"], "light");
        assert_eq!(v["width"], 1600);

        std::fs::write(&path, "pas du json").unwrap();
        write_lite_mode(&path, true).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "pas du json");
    }
}
