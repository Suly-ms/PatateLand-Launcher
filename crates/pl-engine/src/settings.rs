//! Réglages du launcher (même contenu que `configClient` de l'ancien).
//!
//! Écriture atomique ; un fichier illisible est mis de côté (jamais écrasé
//! sans copie) et les valeurs par défaut sont utilisées.

use std::{fs, path::{Path, PathBuf}};

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    #[default]
    Auto,
    Dark,
    Light,
}

/// Comportement du launcher quand le jeu démarre. Mêmes valeurs que
/// `closeLauncher` dans l'ancien launcher, pour l'import des réglages.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum CloseBehavior {
    /// Reste ouvert.
    #[serde(rename = "close-none")]
    KeepOpen,
    /// Réduit dans la zone de notification (défaut).
    #[default]
    #[serde(rename = "close-launcher")]
    Tray,
    /// Fenêtre masquée.
    #[serde(rename = "close-window")]
    Hide,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Memory {
    pub min_gb: f64,
    pub max_gb: f64,
}

impl Memory {
    pub fn min_mb(&self) -> u32 {
        (self.min_gb * 1024.0).round() as u32
    }

    pub fn max_mb(&self) -> u32 {
        (self.max_gb * 1024.0).round() as u32
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    /// `None` tant que le joueur n'a rien choisi : la recommandation s'applique.
    pub memory: Option<Memory>,
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
    pub show_console: bool,
    /// Java choisi par le joueur (sinon celui fourni par le launcher).
    pub java_path: Option<PathBuf>,
    pub download_concurrency: u32,
    pub theme: Theme,
    pub close_behavior: CloseBehavior,
    pub auto_launch: bool,
    pub start_minimized: bool,
    /// Envoi des rapports de crash (désactivé par défaut, comme aujourd'hui).
    pub send_crash_reports: bool,
    pub notify_friend_requests: bool,
    pub notify_friend_messages: bool,
    pub selected_instance: Option<String>,
    pub review_dismissed_accounts: Vec<String>,
    /// Interface sans flou ni animations, pour les PC modestes.
    pub lite_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            memory: None,
            width: 1280,
            height: 720,
            fullscreen: false,
            show_console: false,
            java_path: None,
            download_concurrency: 5,
            theme: Theme::Auto,
            close_behavior: CloseBehavior::Tray,
            auto_launch: false,
            start_minimized: false,
            send_crash_reports: false,
            notify_friend_requests: true,
            notify_friend_messages: true,
            selected_instance: None,
            review_dismissed_accounts: Vec::new(),
            lite_mode: false,
        }
    }
}

/// Plancher du maximum recommandé : les instances PatateLand sont très
/// moddées (près de 300 mods pour Extra).
const MODPACK_MIN_MAX_GB: f64 = 4.0;
/// En dessous, on recommande plutôt l'instance Opti.
pub const LOW_RAM_WARNING_GB: f64 = 6.0;

fn round_half(x: f64) -> f64 {
    (x * 2.0).round() / 2.0
}

/// Maximum autorisé : 80 % de la RAM de la machine.
pub fn max_allowed_gb(total_gb: f64) -> f64 {
    (total_gb * 0.8).floor()
}

/// Même calcul que l'ancien launcher (`computeDefaultRam`), puis borné à
/// 80 % de la RAM. Tout est arrondi au demi-Go : `-Xmx` reçoit toujours un
/// nombre entier de Mo, sinon Java refuse de démarrer.
pub fn recommended_memory(total_gb: f64) -> Memory {
    let min = if total_gb <= 4.0 { 1.0 } else { 2.0 };
    let mut max: f64 = round_half(total_gb * 0.5).max(MODPACK_MIN_MAX_GB);
    if max <= min {
        max = min + 0.5;
    }
    // Comme l'ancien affichage « Recommandé » : jamais plus de 80 % de la RAM,
    // ni moins que le minimum.
    Memory { min_gb: min, max_gb: max.min(max_allowed_gb(total_gb)).max(min) }
}

impl Settings {
    /// Lit les réglages ; un fichier illisible est renommé et remplacé par
    /// les valeurs par défaut.
    pub fn load(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(raw) => match serde_json::from_slice(&raw) {
                Ok(settings) => Ok(settings),
                Err(e) => {
                    let aside = path.with_extension(format!("illisible-{}.json", crate::auth::microsoft::now()));
                    fs::rename(path, &aside)?;
                    tracing::warn!("réglages illisibles ({e}), mis de côté : {}", aside.display());
                    Ok(Self::default())
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.into()),
        }
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = path.with_extension("tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(self)?)?;
        fs::rename(tmp, path)?;
        Ok(())
    }

    /// Mémoire à utiliser sur cette machine : choix du joueur, ramené dans
    /// les limites de la machine si besoin (profil copié depuis un PC plus
    /// puissant), sinon recommandation.
    pub fn effective_memory(&self, total_gb: f64) -> Memory {
        let recommended = recommended_memory(total_gb);
        let Some(chosen) = self.memory else { return recommended };
        let allowed = max_allowed_gb(total_gb).max(recommended.min_gb);
        if chosen.min_gb > total_gb {
            return recommended;
        }
        let max = round_half(chosen.max_gb.min(allowed));
        let min = round_half(chosen.min_gb.min(max));
        Memory { min_gb: min, max_gb: max }
    }

    pub fn validate(&self, total_gb: f64) -> Result<()> {
        if let Some(m) = self.memory {
            if m.min_gb <= 0.0 || m.min_gb > m.max_gb {
                bail!("RAM : le minimum doit être positif et inférieur au maximum");
            }
            if m.max_gb > max_allowed_gb(total_gb) {
                bail!("RAM : {} Go maximum sur ce PC (80 % de {total_gb:.1} Go)", max_allowed_gb(total_gb));
            }
            if (m.min_gb * 2.0).fract() != 0.0 || (m.max_gb * 2.0).fract() != 0.0 {
                bail!("RAM : utiliser des multiples de 0,5 Go");
            }
        }
        if !(1..=32).contains(&self.download_concurrency) {
            bail!("téléchargements simultanés : entre 1 et 32");
        }
        if self.width < 320 || self.height < 240 {
            bail!("résolution trop petite");
        }
        Ok(())
    }
}

/// RAM totale de la machine, en Go.
pub fn total_memory_gb() -> f64 {
    crate::system::total_memory_bytes() as f64 / 1_073_741_824.0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recommendations_match_old_launcher() {
        // (RAM totale, min, max)
        for (total, min, max) in [(2.0, 1.0, 1.0), (4.0, 1.0, 3.0), (8.0, 2.0, 4.0), (15.9, 2.0, 8.0), (16.0, 2.0, 8.0), (32.0, 2.0, 16.0)] {
            let m = recommended_memory(total);
            assert_eq!((m.min_gb, m.max_gb), (min, max), "pour {total} Go");
            assert_eq!(m.max_mb() % 512, 0, "Mo entiers");
        }
    }

    #[test]
    fn chosen_memory_is_clamped_to_machine() {
        let s = Settings { memory: Some(Memory { min_gb: 4.0, max_gb: 24.0 }), ..Default::default() };
        assert_eq!(s.effective_memory(16.0), Memory { min_gb: 4.0, max_gb: 12.0 });
        // Profil d'un PC à 32 Go recopié sur un PC à 2 Go.
        let s = Settings { memory: Some(Memory { min_gb: 4.0, max_gb: 16.0 }), ..Default::default() };
        assert_eq!(s.effective_memory(2.0), recommended_memory(2.0));
    }

    #[test]
    fn corrupt_file_is_set_aside() {
        let dir = std::env::temp_dir().join(format!("pl-settings-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("settings.json");
        fs::write(&path, "{ cassé").unwrap();
        assert_eq!(Settings::load(&path).unwrap(), Settings::default());
        let kept = fs::read_dir(&dir).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("illisible"));
        assert!(kept, "l'ancien fichier doit être conservé");
    }

    #[test]
    fn partial_file_keeps_defaults() {
        let s: Settings = serde_json::from_str(r#"{ "fullscreen": true, "close_behavior": "close-none" }"#).unwrap();
        assert!(s.fullscreen);
        assert_eq!(s.close_behavior, CloseBehavior::KeepOpen);
        assert_eq!(s.download_concurrency, 5);
    }
}
