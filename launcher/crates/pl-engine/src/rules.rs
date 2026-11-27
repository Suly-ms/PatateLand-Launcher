//! Règles conditionnelles des fichiers de version Mojang (OS, architecture).

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
pub struct Rule {
    pub action: String,
    #[serde(default)]
    pub os: Option<OsRule>,
    #[serde(default)]
    pub features: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OsRule {
    pub name: Option<String>,
    pub arch: Option<String>,
    pub version: Option<String>,
}

pub fn os_name() -> &'static str {
    if cfg!(windows) {
        "windows"
    } else if cfg!(target_os = "macos") {
        "osx"
    } else {
        "linux"
    }
}

pub fn arch() -> &'static str {
    if cfg!(target_arch = "x86") {
        "x86"
    } else if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x86_64"
    }
}

fn matches(rule: &Rule) -> bool {
    // Les « features » (démo, résolution personnalisée, quick play...) sont
    // gérées à part par le lanceur : on les considère toutes désactivées.
    if rule.features.is_some() {
        return false;
    }
    let Some(os) = &rule.os else { return true };
    if os.name.as_deref().is_some_and(|n| n != os_name()) {
        return false;
    }
    if os.arch.as_deref().is_some_and(|a| a != arch()) {
        return false;
    }
    // Seule règle de version utilisée par Mojang : « ^10\. » (Windows 10/11,
    // qui se déclarent tous deux en 10.0).
    if let Some(version) = &os.version {
        return cfg!(windows) && version.starts_with("^10\\.");
    }
    true
}

/// Applique une liste de règles : sans règle, tout est autorisé ; sinon la
/// dernière règle applicable décide.
pub fn allowed(rules: Option<&[Rule]>) -> bool {
    match rules {
        None | Some([]) => true,
        Some(rules) => rules
            .iter()
            .filter(|r| matches(r))
            .last()
            .is_some_and(|r| r.action == "allow"),
    }
}
