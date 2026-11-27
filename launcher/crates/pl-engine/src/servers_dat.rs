//! Ajoute le serveur PatateLand en tête de la liste multijoueur
//! (`servers.dat`) d'une instance.
//!
//! Par rapport à l'ancien launcher :
//! - tous les champs des serveurs du joueur sont conservés (icône, réglages) ;
//! - un fichier illisible est sauvegardé avant d'être recréé, jamais perdu ;
//! - l'écriture se fait avant le lancement du jeu, et de façon atomique.

use std::{fs, path::Path};

use anyhow::Result;

use crate::nbt::{self, Tag};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ServerEntry {
    pub name: String,
    /// `hôte` ou `hôte:port`.
    pub ip: String,
}

/// Table de l'ancien launcher, utilisée quand le serveur de fichiers ne
/// fournit pas d'adresse (`status`) pour l'instance.
pub fn default_server(instance: &str) -> Option<ServerEntry> {
    let (ip, name) = match instance {
        "Opti" | "Extra" => ("play.patateland.fr", "PatateLand"),
        "Event" => ("patateland-event.mine.fun", "PatateLand - Event"),
        _ => return None,
    };
    Some(ServerEntry { name: name.into(), ip: ip.into() })
}

/// Adresse issue du champ `status` d'une instance de `/files`
/// (`{ nameServer, ip, port }`).
pub fn from_status(status: &serde_json::Value) -> Option<ServerEntry> {
    let host = status["ip"].as_str()?.trim();
    if host.is_empty() {
        return None;
    }
    let port = status["port"].as_u64().or_else(|| status["port"].as_str()?.parse().ok());
    let ip = match port {
        Some(p) if p != 25565 => format!("{host}:{p}"),
        _ => host.to_owned(),
    };
    let name = status["nameServer"].as_str().unwrap_or("PatateLand").to_owned();
    Some(ServerEntry { name, ip })
}

#[derive(Debug, PartialEq, Eq)]
pub enum Injected {
    Created,
    Updated,
    /// L'ancien fichier était illisible : copie conservée sous ce nom.
    RecoveredFromCorrupt(String),
}

pub fn inject(instance_dir: &Path, server: &ServerEntry) -> Result<Injected> {
    fs::create_dir_all(instance_dir)?;
    let path = instance_dir.join("servers.dat");

    let (outcome, mut servers, mut root_fields, root_name) = match fs::read(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (Injected::Created, Vec::new(), Vec::new(), String::new()),
        Err(e) => return Err(e.into()),
        Ok(bytes) => match nbt::read(&bytes) {
            Ok((name, Tag::Compound(mut fields))) => {
                let servers = match fields.iter().position(|(k, _)| k == "servers") {
                    Some(i) => match fields.remove(i).1 {
                        Tag::List(_, items) => items,
                        _ => Vec::new(),
                    },
                    None => Vec::new(),
                };
                (Injected::Updated, servers, fields, name)
            }
            _ => {
                let backup = format!("servers.dat.illisible-{}", crate::auth::microsoft::now());
                fs::write(instance_dir.join(&backup), &bytes)?;
                tracing::warn!("servers.dat illisible, copie conservée : {backup}");
                (Injected::RecoveredFromCorrupt(backup), Vec::new(), Vec::new(), String::new())
            }
        },
    };

    let same_ip = |t: &Tag| t.get("ip").and_then(Tag::as_str).is_some_and(|ip| ip.trim().eq_ignore_ascii_case(&server.ip));
    // On réutilise l'entrée existante (icône, réglages) au lieu d'en recréer une.
    let mut entry = match servers.iter().position(same_ip) {
        Some(i) => servers.remove(i),
        None => Tag::Compound(vec![("ip".into(), Tag::String(server.ip.clone()))]),
    };
    servers.retain(|t| !same_ip(t));
    if let Tag::Compound(fields) = &mut entry {
        match fields.iter_mut().find(|(k, _)| k == "name") {
            Some((_, name)) => *name = Tag::String(server.name.clone()),
            None => fields.push(("name".into(), Tag::String(server.name.clone()))),
        }
    }
    servers.insert(0, entry);

    root_fields.insert(0, ("servers".into(), Tag::List(10, servers)));
    let bytes = nbt::write(&root_name, &Tag::Compound(root_fields));
    let tmp = instance_dir.join("servers.dat.tmp");
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, &path)?;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("pl-serversdat-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        d
    }

    fn list(dir: &Path) -> Vec<Tag> {
        let (_, root) = nbt::read(&fs::read(dir.join("servers.dat")).unwrap()).unwrap();
        match root.get("servers").unwrap() {
            Tag::List(_, items) => items.clone(),
            _ => panic!(),
        }
    }

    fn server(ip: &str, name: &str, icon: Option<&str>) -> Tag {
        let mut f = vec![("ip".into(), Tag::String(ip.into())), ("name".into(), Tag::String(name.into()))];
        if let Some(icon) = icon {
            f.push(("icon".into(), Tag::String(icon.into())));
        }
        Tag::Compound(f)
    }

    #[test]
    fn creates_file() {
        let d = dir("create");
        let target = default_server("Opti").unwrap();
        assert_eq!(inject(&d, &target).unwrap(), Injected::Created);
        let l = list(&d);
        assert_eq!(l.len(), 1);
        assert_eq!(l[0].get("ip").and_then(Tag::as_str), Some("play.patateland.fr"));
    }

    #[test]
    fn keeps_player_servers_and_icons_and_moves_ours_first() {
        let d = dir("keep");
        fs::create_dir_all(&d).unwrap();
        let root = Tag::Compound(vec![(
            "servers".into(),
            Tag::List(10, vec![
                server("hypixel.net", "Hypixel", Some("ICONE-JOUEUR")),
                server("PLAY.patateland.fr", "Ancien nom", Some("ICONE-PATATE")),
                server("play.patateland.fr", "Doublon", None),
            ]),
        )]);
        fs::write(d.join("servers.dat"), nbt::write("", &root)).unwrap();

        inject(&d, &default_server("Extra").unwrap()).unwrap();
        let l = list(&d);
        assert_eq!(l.len(), 2, "doublons retirés");
        assert_eq!(l[0].get("name").and_then(Tag::as_str), Some("PatateLand"));
        assert_eq!(l[0].get("icon").and_then(Tag::as_str), Some("ICONE-PATATE"), "icône conservée");
        assert_eq!(l[1].get("icon").and_then(Tag::as_str), Some("ICONE-JOUEUR"), "serveur du joueur intact");
    }

    #[test]
    fn corrupt_file_is_backed_up_not_lost() {
        let d = dir("corrupt");
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join("servers.dat"), b"pas du NBT").unwrap();
        let outcome = inject(&d, &default_server("Event").unwrap()).unwrap();
        let Injected::RecoveredFromCorrupt(backup) = outcome else { panic!("{outcome:?}") };
        assert_eq!(fs::read(d.join(backup)).unwrap(), b"pas du NBT");
        assert_eq!(list(&d).len(), 1);
    }

    /// `PL_SERVERS_DAT=<fichier> cargo test -- --ignored real_file` : relit un
    /// vrai servers.dat et vérifie que la réécriture est identique à l'octet.
    #[test]
    #[ignore]
    fn real_file_roundtrip_is_byte_identical() {
        let path = std::env::var("PL_SERVERS_DAT").expect("PL_SERVERS_DAT non défini");
        let original = fs::read(path).unwrap();
        let (name, root) = nbt::read(&original).unwrap();
        if let Some(Tag::List(_, items)) = root.get("servers") {
            for s in items {
                println!("serveur : {:?} -> {:?}", s.get("name").and_then(Tag::as_str), s.get("ip").and_then(Tag::as_str));
            }
        }
        assert_eq!(nbt::write(&name, &root), original);
    }

    #[test]
    fn status_parsing() {
        let s = from_status(&serde_json::json!({ "nameServer": "PatateLand", "ip": "play.patateland.fr", "port": 25565 })).unwrap();
        assert_eq!(s.ip, "play.patateland.fr");
        let s = from_status(&serde_json::json!({ "ip": "x.fr", "port": "25570" })).unwrap();
        assert_eq!(s.ip, "x.fr:25570");
        assert!(from_status(&serde_json::json!({ "ip": "" })).is_none());
    }
}
