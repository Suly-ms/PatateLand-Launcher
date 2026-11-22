//! Intégration Windows, toujours pour l'utilisateur courant (HKCU, dossiers
//! personnels) : aucun droit administrateur n'est demandé.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};
use windows_registry::CURRENT_USER;

/// Nom affiché partout (raccourcis, « Applications installées »), identique
/// au `productName` du launcher.
pub const PRODUCT: &str = "PatateLand";
pub const LAUNCHER_EXE: &str = "PatateLand.exe";
pub const UNINSTALLER_EXE: &str = "uninstall.exe";
pub const PUBLISHER: &str = "PatateLand";

const UNINSTALL_ROOT: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PatateLand";
/// Clé laissée par l'installateur NSIS de Tauri.
const NSIS_KEY: &str = r"Software\PatateLand\PatateLand";

/// Versions de test « PatateLand Rust » (avant le nom définitif) : retirées à
/// l'installation de la version finale.
pub mod legacy {
    pub const PRODUCT: &str = "PatateLand Rust";
    pub const LAUNCHER_EXE: &str = "PatateLand Rust.exe";
    pub const UNINSTALL_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Uninstall\PatateLand Rust";
    pub const NSIS_KEY: &str = r"Software\PatateLand\PatateLand Rust";
}

/// Ancien launcher Electron : clé de désinstallation créée par
/// electron-builder (UUID tiré de l'appId « fr.patateland.launcher »).
const ELECTRON_KEY: &str = "942ef986-80ef-50d2-ae21-cc32a69b8aff";
const ELECTRON_PUBLISHER: &str = "Suly-ms, Kales, Inc.";
/// Désinstallateur de l'ancien launcher : sert aussi à reconnaître son dossier.
pub const ELECTRON_UNINSTALLER: &str = "Uninstall PatateLand.exe";
const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
const STARTUP_APPROVED_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
/// Argument ajouté par le launcher (tauri-plugin-autostart) au démarrage de Windows.
const AUTOSTART_ARG: &str = "--autostart";

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

// ---------- Dossiers ----------

fn known_folder(id: &windows_sys::core::GUID) -> Option<PathBuf> {
    use windows_sys::Win32::System::Com::CoTaskMemFree;
    use windows_sys::Win32::UI::Shell::SHGetKnownFolderPath;
    let mut raw: *mut u16 = std::ptr::null_mut();
    // SAFETY: `raw` reçoit une chaîne allouée par Windows, libérée juste après.
    unsafe {
        let ok = SHGetKnownFolderPath(id, 0, std::ptr::null_mut(), &mut raw) == 0;
        let path = ok.then(|| {
            let len = (0..).take_while(|&i| *raw.add(i) != 0).count();
            PathBuf::from(String::from_utf16_lossy(std::slice::from_raw_parts(raw, len)))
        });
        CoTaskMemFree(raw.cast());
        path
    }
}

/// Bureau réel de l'utilisateur (y compris s'il est redirigé vers OneDrive).
pub fn desktop_dir() -> Option<PathBuf> {
    known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_Desktop)
}

/// Menu Démarrer de l'utilisateur (« Programmes »).
pub fn start_menu_dir() -> Option<PathBuf> {
    known_folder(&windows_sys::Win32::UI::Shell::FOLDERID_Programs)
}

/// Nom des raccourcis tant que l'ancien launcher est encore installé (bêta) :
/// les siens s'appellent déjà « PatateLand ».
pub const SHORTCUT_BESIDE_OLD: &str = "PatateLand (nouveau)";

/// Raccourcis « nom.lnk » sur le bureau et dans le menu Démarrer.
pub fn shortcuts(name: &str) -> [Option<PathBuf>; 2] {
    [desktop_dir(), start_menu_dir()].map(|d| d.map(|d| d.join(format!("{name}.lnk"))))
}

pub fn desktop_shortcut() -> Option<PathBuf> {
    [PRODUCT, SHORTCUT_BESIDE_OLD].into_iter().filter_map(|n| shortcuts(n)[0].clone()).find(|p| p.exists())
}

pub fn start_menu_shortcut() -> Option<PathBuf> {
    [PRODUCT, SHORTCUT_BESIDE_OLD].into_iter().filter_map(|n| shortcuts(n)[1].clone()).find(|p| p.exists())
}

fn env_dir(name: &str) -> PathBuf {
    std::env::var_os(name).map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

/// `%LOCALAPPDATA%\PatateLand` (l'ancien launcher est dans `%LOCALAPPDATA%\Programs\PatateLand`).
pub fn default_install_dir() -> PathBuf {
    env_dir("LOCALAPPDATA").join(PRODUCT)
}

/// Réglages du launcher (`%APPDATA%\PatateLand-Rust\settings.json`).
pub fn launcher_settings() -> PathBuf {
    env_dir("APPDATA").join("PatateLand-Rust").join("settings.json")
}

// ---------- Raccourcis ----------

pub fn create_shortcut(link: &Path, target: &Path) -> Result<()> {
    if let Some(parent) = link.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut shortcut = mslnk::ShellLink::new(target).context("raccourci")?;
    shortcut.set_working_dir(target.parent().map(|p| p.display().to_string()));
    shortcut.set_icon_location(Some(target.display().to_string()));
    shortcut.create_lnk(link).with_context(|| format!("création du raccourci {}", link.display()))?;
    Ok(())
}

// ---------- Registre ----------

pub struct ExistingInstall {
    pub dir: PathBuf,
    pub version: String,
}

/// Installation déjà présente (par cet installateur ou par celui de NSIS).
pub fn existing_install() -> Option<ExistingInstall> {
    let key = CURRENT_USER.open(UNINSTALL_KEY).ok()?;
    let dir = key.get_string("InstallLocation").ok()?;
    let dir = PathBuf::from(dir.trim().trim_matches('"'));
    dir.join(LAUNCHER_EXE).is_file().then(|| ExistingInstall { dir, version: key.get_string("DisplayVersion").unwrap_or_default() })
}

pub struct Registration<'a> {
    pub dir: &'a Path,
    pub version: &'a str,
    pub size_kb: u32,
}

/// Entrée dans « Applications installées » de Windows.
pub fn register_uninstall(r: &Registration) -> Result<()> {
    let key = CURRENT_USER.create(UNINSTALL_KEY).context("registre")?;
    let exe = r.dir.join(LAUNCHER_EXE);
    let uninstaller = r.dir.join(UNINSTALLER_EXE);
    key.set_string("DisplayName", PRODUCT)?;
    key.set_string("DisplayIcon", format!("\"{}\"", exe.display()))?;
    key.set_string("DisplayVersion", r.version)?;
    key.set_string("Publisher", PUBLISHER)?;
    key.set_string("InstallLocation", r.dir.display().to_string())?;
    key.set_string("UninstallString", format!("\"{}\" --uninstall", uninstaller.display()))?;
    key.set_string("QuietUninstallString", format!("\"{}\" --uninstall --quiet", uninstaller.display()))?;
    key.set_u32("EstimatedSize", r.size_kb)?;
    key.set_u32("NoModify", 1)?;
    key.set_u32("NoRepair", 1)?;
    Ok(())
}

pub fn unregister_uninstall() {
    let _ = CURRENT_USER.remove_tree(UNINSTALL_KEY);
    let _ = CURRENT_USER.remove_tree(NSIS_KEY);
}

// ---------- Ancien launcher (Electron) ----------

/// Ancien launcher installé pour l'utilisateur courant.
pub struct ElectronInstall {
    /// Dossier d'installation (`%LOCALAPPDATA%\Programs\PatateLand`).
    pub dir: PathBuf,
    pub uninstaller: PathBuf,
    pub version: String,
}

/// Valeurs d'une entrée « Applications installées », pour la reconnaître.
#[derive(Debug, Default, Clone)]
pub struct UninstallEntry {
    pub key: String,
    pub display_name: String,
    pub publisher: String,
    pub version: String,
    pub uninstall_string: String,
}

/// Reconnaît l'ancien launcher : sa clé connue, ou son éditeur et son nom.
pub fn is_electron_entry(entry: &UninstallEntry) -> bool {
    entry.key.eq_ignore_ascii_case(ELECTRON_KEY)
        || (entry.publisher == ELECTRON_PUBLISHER && entry.display_name.starts_with("PatateLand"))
}

/// Chemin du désinstallateur dans `"C:\…\Uninstall PatateLand.exe" /currentuser /S`.
pub fn uninstaller_path(uninstall_string: &str) -> Option<PathBuf> {
    let s = uninstall_string.trim();
    let path = match s.strip_prefix('"') {
        Some(rest) => rest.split('"').next()?,
        None => s.split(" /").next()?,
    };
    let path = PathBuf::from(path.trim());
    path.file_name()
        .is_some_and(|n| n.to_string_lossy().eq_ignore_ascii_case(ELECTRON_UNINSTALLER))
        .then_some(path)
}

fn uninstall_entries() -> Vec<UninstallEntry> {
    let Ok(root) = CURRENT_USER.open(UNINSTALL_ROOT) else { return Vec::new() };
    let Ok(keys) = root.keys() else { return Vec::new() };
    keys.filter_map(|name| {
        let key = root.open(&name).ok()?;
        let get = |v: &str| key.get_string(v).unwrap_or_default();
        Some(UninstallEntry {
            display_name: get("DisplayName"),
            publisher: get("Publisher"),
            version: get("DisplayVersion"),
            uninstall_string: get("UninstallString"),
            key: name,
        })
    })
    .collect()
}

pub fn electron_install() -> Option<ElectronInstall> {
    let entry = uninstall_entries().into_iter().find(is_electron_entry)?;
    let uninstaller = uninstaller_path(&entry.uninstall_string)?;
    if !uninstaller.is_file() {
        return None;
    }
    Some(ElectronInstall { dir: uninstaller.parent()?.to_path_buf(), uninstaller, version: entry.version })
}

/// Désinstalle l'ancien launcher avec son propre désinstallateur, en mode
/// silencieux, puis attend la fin (le désinstallateur NSIS se relance depuis
/// un dossier temporaire et rend la main tout de suite). Ses données (comptes,
/// jeu) ne sont pas supprimées par ce désinstallateur.
pub fn uninstall_electron(old: &ElectronInstall) -> Result<()> {
    let exe = old.dir.join("PatateLand.exe");
    // Lancé par la mise à jour de l'ancien launcher : il est en train de se fermer.
    for _ in 0..60 {
        if !is_running(&exe) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    if is_running(&exe) {
        anyhow::bail!("l'ancien launcher PatateLand est encore ouvert. Ferme-le, puis clique sur Réessayer.");
    }
    std::process::Command::new(&old.uninstaller)
        .args(["/currentuser", "/S"])
        .status()
        .context("lancement du désinstallateur de l'ancien launcher")?;
    for _ in 0..120 {
        if !old.uninstaller.exists() {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(500));
    }
    // Démarrage automatique de l'ancien (même nom que le nouveau) : retiré
    // s'il pointe encore vers l'ancien dossier.
    if let Ok(key) = CURRENT_USER.options().write().open(RUN_KEY) {
        let old_dir = old.dir.display().to_string().to_lowercase();
        if key.get_string(PRODUCT).is_ok_and(|v| v.to_lowercase().contains(&old_dir)) {
            let _ = key.remove_value(PRODUCT);
        }
    }
    if old.uninstaller.exists() {
        anyhow::bail!("la désinstallation de l'ancien launcher n'a pas abouti");
    }
    Ok(())
}

/// Retire une version de test « PatateLand Rust » : programme, raccourcis,
/// démarrage automatique et entrée « Applications installées ». Ses données
/// (comptes, réglages) restent.
pub fn remove_legacy_install() {
    let Ok(key) = CURRENT_USER.open(legacy::UNINSTALL_KEY) else { return };
    let dir = key.get_string("InstallLocation").map(|d| PathBuf::from(d.trim().trim_matches('"'))).ok();
    drop(key);
    for dir in [desktop_dir(), start_menu_dir()].into_iter().flatten() {
        let _ = std::fs::remove_file(dir.join(format!("{}.lnk", legacy::PRODUCT)));
    }
    if let Ok(run) = CURRENT_USER.options().write().open(RUN_KEY) {
        let _ = run.remove_value(legacy::PRODUCT);
    }
    if let Some(dir) = dir.filter(|d| d.join(legacy::LAUNCHER_EXE).is_file() && !is_running(&d.join(legacy::LAUNCHER_EXE))) {
        let _ = std::fs::remove_file(dir.join(legacy::LAUNCHER_EXE));
        let _ = std::fs::remove_file(dir.join(UNINSTALLER_EXE));
        let _ = std::fs::remove_dir(&dir);
    }
    let _ = CURRENT_USER.remove_tree(legacy::UNINSTALL_KEY);
    let _ = CURRENT_USER.remove_tree(legacy::NSIS_KEY);
}

/// Version de test « PatateLand Rust » en cours d'exécution.
pub fn legacy_running() -> bool {
    CURRENT_USER
        .open(legacy::UNINSTALL_KEY)
        .and_then(|k| k.get_string("InstallLocation"))
        .is_ok_and(|d| is_running(&PathBuf::from(d.trim().trim_matches('"')).join(legacy::LAUNCHER_EXE)))
}

/// Démarrage avec Windows : même valeur que celle écrite par le launcher
/// lui-même (tauri-plugin-autostart), pour que son réglage reste cohérent.
pub fn set_autostart(exe: &Path, enabled: bool) -> Result<()> {
    if enabled {
        CURRENT_USER.create(RUN_KEY)?.set_string(PRODUCT, format!("{} {AUTOSTART_ARG}", exe.display()))?;
        // Si l'utilisateur l'avait désactivé dans le Gestionnaire des tâches.
        if let Ok(key) = CURRENT_USER.options().write().open(STARTUP_APPROVED_KEY) {
            let _ = key.set_bytes(PRODUCT, windows_registry::Type::Bytes, &[2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
        }
    } else if let Ok(key) = CURRENT_USER.options().write().open(RUN_KEY) {
        // Même nom que le démarrage automatique de l'ancien launcher : on ne
        // retire la valeur que si elle lance bien ce launcher-ci.
        let ours = exe.display().to_string().to_lowercase();
        if key.get_string(PRODUCT).is_ok_and(|v| v.to_lowercase().contains(&ours)) {
            let _ = key.remove_value(PRODUCT);
        }
    }
    Ok(())
}

pub fn autostart_enabled() -> bool {
    CURRENT_USER.open(RUN_KEY).and_then(|k| k.get_string(PRODUCT)).is_ok()
}

// ---------- Divers ----------

/// Vrai si l'exe est en cours d'exécution (Windows refuse alors de l'ouvrir
/// en écriture).
pub fn is_running(exe: &Path) -> bool {
    exe.is_file() && std::fs::OpenOptions::new().write(true).open(exe).is_err()
}

/// WebView2 est nécessaire pour afficher l'installateur et le launcher.
pub fn webview2_installed() -> bool {
    const CLIENT: &str = r"Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";
    let present = |root: &windows_registry::Key, path: String| {
        root.open(path).and_then(|k| k.get_string("pv")).is_ok_and(|v| !v.is_empty() && v != "0.0.0.0")
    };
    present(windows_registry::LOCAL_MACHINE, format!(r"SOFTWARE\WOW6432Node\{CLIENT}"))
        || present(windows_registry::LOCAL_MACHINE, format!(r"SOFTWARE\{CLIENT}"))
        || present(CURRENT_USER, format!(r"Software\{CLIENT}"))
}

pub enum Answer {
    Yes,
    No,
}

fn message_box(text: &str, flags: u32) -> i32 {
    use windows_sys::Win32::UI::WindowsAndMessaging::MessageBoxW;
    let (text, title) = (wide(text), wide(&format!("{PRODUCT} - Installation")));
    // SAFETY: chaînes terminées par zéro, pas de fenêtre parente.
    unsafe { MessageBoxW(std::ptr::null_mut(), text.as_ptr(), title.as_ptr(), flags) }
}

pub fn info(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONINFORMATION, MB_OK};
    message_box(text, MB_OK | MB_ICONINFORMATION);
}

pub fn error(text: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MB_ICONERROR, MB_OK};
    message_box(text, MB_OK | MB_ICONERROR);
}

pub fn ask(text: &str) -> Answer {
    use windows_sys::Win32::UI::WindowsAndMessaging::{IDYES, MB_ICONQUESTION, MB_YESNO};
    if message_box(text, MB_YESNO | MB_ICONQUESTION) == IDYES { Answer::Yes } else { Answer::No }
}

/// Lance un programme détaché de l'installateur (qui peut se fermer).
pub fn spawn_detached(exe: &Path, args: &[&str]) -> Result<()> {
    use std::os::windows::process::CommandExt;
    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    std::process::Command::new(exe)
        .args(args)
        .current_dir(exe.parent().unwrap_or(Path::new(".")))
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .with_context(|| format!("lancement de {}", exe.display()))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, name: &str, publisher: &str) -> UninstallEntry {
        UninstallEntry { key: key.into(), display_name: name.into(), publisher: publisher.into(), ..Default::default() }
    }

    #[test]
    fn recognizes_the_old_electron_launcher_only() {
        // Entrée réelle relevée sur un PC (ancien launcher 1.4.2).
        assert!(is_electron_entry(&entry("942ef986-80ef-50d2-ae21-cc32a69b8aff", "PatateLand 1.4.2", "Suly-ms, Kales, Inc.")));
        assert!(is_electron_entry(&entry("autre-clé", "PatateLand 1.5.0", "Suly-ms, Kales, Inc.")));
        // Le nouveau launcher et ses versions de test ne sont jamais pris pour l'ancien.
        assert!(!is_electron_entry(&entry("PatateLand", "PatateLand", "PatateLand")));
        assert!(!is_electron_entry(&entry("PatateLand Rust", "PatateLand Rust", "PatateLand")));
        assert!(!is_electron_entry(&entry("x", "Autre jeu", "Suly-ms, Kales, Inc.")));
    }

    #[test]
    fn reads_the_uninstaller_from_the_command() {
        let quoted = r#""C:\Users\joueur\AppData\Local\Programs\PatateLand\Uninstall PatateLand.exe" /currentuser /S"#;
        assert_eq!(
            uninstaller_path(quoted),
            Some(PathBuf::from(r"C:\Users\joueur\AppData\Local\Programs\PatateLand\Uninstall PatateLand.exe"))
        );
        let plain = r"C:\Jeux\PatateLand\Uninstall PatateLand.exe /currentuser";
        assert_eq!(uninstaller_path(plain), Some(PathBuf::from(r"C:\Jeux\PatateLand\Uninstall PatateLand.exe")));
        // Tout autre programme est refusé (on ne lance jamais un exécutable inconnu).
        assert_eq!(uninstaller_path(r#""C:\Windows\System32\cmd.exe" /c del"#), None);
    }
}
