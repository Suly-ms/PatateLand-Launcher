//! Détection des crashs du jeu et préparation du rapport.
//!
//! L'envoi passera par une route du site PatateLand (voir docs/02, §3),
//! jamais directement vers Discord. Rien n'est envoyé sans l'accord du
//! joueur (`send_crash_reports`).

use std::{
    fs,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use anyhow::Result;
use serde::Serialize;

use crate::system::{self, SystemInfo};

/// Taille maximale du rapport joint (comme l'ancien launcher).
const MAX_REPORT_BYTES: usize = 900_000;

#[derive(Debug, Clone, Serialize)]
pub struct CrashReport {
    pub instance: String,
    pub launcher_version: String,
    pub player: String,
    pub exit_code: Option<i32>,
    pub file_name: String,
    pub system: SystemInfo,
    /// Contenu nettoyé (chemins personnels masqués), éventuellement tronqué.
    pub content: String,
}

/// Rapport de crash le plus récent écrit depuis `since` (5 s de marge,
/// comme l'ancien launcher).
pub fn find_report(instance_dir: &Path, since: SystemTime) -> Option<PathBuf> {
    let since = since.checked_sub(Duration::from_secs(5)).unwrap_or(since);
    fs::read_dir(instance_dir.join("crash-reports"))
        .ok()?
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().to_lowercase().ends_with(".txt"))
        .filter_map(|e| Some((e.metadata().ok()?.modified().ok()?, e.path())))
        .filter(|(modified, _)| *modified >= since)
        .max_by_key(|(modified, _)| *modified)
        .map(|(_, path)| path)
}

/// Masque le dossier personnel (et donc le nom d'utilisateur Windows).
pub fn sanitize(text: &str, home: Option<&Path>) -> String {
    let Some(home) = home.map(|h| h.display().to_string()).filter(|h| h.len() > 3) else {
        return text.to_owned();
    };
    let variants = [home.clone(), home.replace('\\', "/"), home.replace('\\', "\\\\")];
    let mut out = text.to_owned();
    for v in variants {
        out = replace_ignore_case(&out, &v, "%USERPROFILE%");
    }
    out
}

fn replace_ignore_case(text: &str, needle: &str, with: &str) -> String {
    let (lower, needle_lower) = (text.to_lowercase(), needle.to_lowercase());
    // Si la mise en minuscules change la longueur (rare), remplacement simple.
    if lower.len() != text.len() {
        return text.replace(needle, with);
    }
    let mut out = String::with_capacity(text.len());
    let mut last = 0;
    for (i, _) in lower.match_indices(&needle_lower) {
        out.push_str(&text[last..i]);
        out.push_str(with);
        last = i + needle.len();
    }
    out.push_str(&text[last..]);
    out
}

pub fn prepare(
    instance: &str,
    player: &str,
    exit_code: Option<i32>,
    report_path: &Path,
) -> Result<CrashReport> {
    let raw = fs::read(report_path)?;
    let mut content = sanitize(&String::from_utf8_lossy(&raw), home_dir().as_deref());
    if content.len() > MAX_REPORT_BYTES {
        let mut cut = MAX_REPORT_BYTES;
        while !content.is_char_boundary(cut) {
            cut -= 1;
        }
        content.truncate(cut);
        content.push_str("\n\n[...rapport tronqué...]");
    }
    Ok(CrashReport {
        instance: instance.to_owned(),
        launcher_version: env!("CARGO_PKG_VERSION").to_owned(),
        player: player.to_owned(),
        exit_code,
        file_name: report_path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        system: system::collect(),
        content,
    })
}

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")).map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hides_personal_paths() {
        let text = r"at C:\Users\Kales\AppData\Roaming\.patateland and c:/users/kales/x and C:\\Users\\Kales\\y";
        let out = sanitize(text, Some(Path::new(r"C:\Users\Kales")));
        assert!(!out.to_lowercase().contains("kales"), "{out}");
        assert_eq!(out.matches("%USERPROFILE%").count(), 3);
    }

    #[test]
    fn finds_latest_recent_report() {
        let dir = std::env::temp_dir().join(format!("pl-crash-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let reports = dir.join("crash-reports");
        fs::create_dir_all(&reports).unwrap();
        assert!(find_report(&dir, SystemTime::now()).is_none());
        let since = SystemTime::now();
        fs::write(reports.join("crash-2026-11-20_18.00.00-client.txt"), "---- Minecraft Crash Report ----").unwrap();
        fs::write(reports.join("notes.log"), "pas un rapport").unwrap();
        let found = find_report(&dir, since).unwrap();
        assert!(found.ends_with("crash-2026-11-20_18.00.00-client.txt"));
        let report = prepare("Extra", "PatateTest", Some(-1), &found).unwrap();
        assert!(report.content.starts_with("---- Minecraft Crash Report"));
        assert!(report.system.cores > 0);
    }
}
