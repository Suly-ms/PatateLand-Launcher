//! Installation de Forge (1.13+, testé sur 1.20.1).
//!
//! Reproduit ce que fait l'installateur officiel côté client :
//! 1. récupère `install_profile.json` et `version.json` dans l'installateur ;
//! 2. extrait les jars Forge embarqués (`maven/`) et télécharge les autres
//!    bibliothèques ;
//! 3. exécute les « processors » (remappage et patch du jar Minecraft) avec
//!    le Java du jeu ;
//! 4. écrit `versions/<id>/<id>.json`.
//!
//! Les processors ne sont relancés que si l'installateur a changé ou si un
//! de leurs fichiers produits a disparu.

use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
};

use anyhow::{Context, Result, bail};
use serde::Deserialize;

use crate::{
    CP_SEP, Ctx, integrity, maven,
    net::{self, DownloadItem},
    paths::GamePaths,
    vanilla::{self, Library, VersionJson},
};

const FORGE_MAVEN: &str = "https://maven.minecraftforge.net";
const PROMOTIONS: &str = "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json";

#[derive(Debug, Deserialize)]
struct InstallProfile {
    #[serde(default)]
    data: HashMap<String, SidedValue>,
    #[serde(default)]
    processors: Vec<Processor>,
    #[serde(default)]
    libraries: Vec<Library>,
}

#[derive(Debug, Deserialize)]
struct SidedValue {
    client: String,
}

#[derive(Debug, Deserialize)]
struct Processor {
    jar: String,
    #[serde(default)]
    classpath: Vec<String>,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    outputs: HashMap<String, String>,
    #[serde(default)]
    sides: Option<Vec<String>>,
}

pub struct ForgeInstall {
    /// Ex. `1.20.1-forge-47.4.16`.
    pub id: String,
    pub version: VersionJson,
}

/// Traduit la version demandée par le serveur (`latest`, `recommended`,
/// `47.4.16` ou `1.20.1-47.4.16`) en numéro de build Forge.
pub async fn resolve_version(ctx: &Ctx, mc: &str, requested: &str) -> Result<String> {
    match requested {
        "latest" | "recommended" => {
            let promos: serde_json::Value = net::get_json(&ctx.client, PROMOTIONS).await?;
            let key = format!("{mc}-{requested}");
            promos["promos"][&key]
                .as_str()
                .map(str::to_owned)
                .with_context(|| format!("aucune version Forge « {key} »"))
        }
        v => Ok(v.strip_prefix(&format!("{mc}-")).unwrap_or(v).to_owned()),
    }
}

/// Versions de Forge déjà installées pour `mc`, de la plus récente à la plus
/// ancienne (utilisé hors connexion, quand « latest » ne peut pas être résolu).
pub fn installed_versions(paths: &GamePaths, mc: &str) -> Vec<String> {
    let prefix = format!("{mc}-forge-");
    let Ok(entries) = fs::read_dir(paths.root().join("versions")) else { return Vec::new() };
    let mut versions: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().join(".pl-installed").exists())
        .filter_map(|e| e.file_name().to_string_lossy().strip_prefix(&prefix).map(str::to_owned))
        .collect();
    let key = |v: &String| v.split('.').map(|n| n.parse::<u32>().unwrap_or(0)).collect::<Vec<_>>();
    versions.sort_by_key(|v| std::cmp::Reverse(key(v)));
    versions
}

pub async fn install(
    ctx: &Ctx,
    vanilla: &VersionJson,
    forge_version: &str,
    java: &Path,
) -> Result<ForgeInstall> {
    let mc = vanilla.id.clone();
    let full = format!("{mc}-{forge_version}");
    let id = format!("{mc}-forge-{forge_version}");

    let installer_rel = format!("net/minecraftforge/forge/{full}/forge-{full}-installer.jar");
    let installer = ctx.paths.libraries().join(&installer_rel);
    let url = format!("{FORGE_MAVEN}/{installer_rel}");
    let installer_sha1 = fetch_sha1(ctx, &format!("{url}.sha1")).await;
    ctx.ensure(vec![DownloadItem {
        url,
        path: installer.clone(),
        sha1: installer_sha1.clone(),
        size: None,
    }])
    .await?;

    let (zip_path, libs) = (installer.clone(), ctx.paths.libraries());
    let (profile, version_raw) = tokio::task::spawn_blocking(move || -> Result<(InstallProfile, String)> {
        let mut zip = open_zip(&zip_path)?;
        let profile = serde_json::from_str(&read_entry(&mut zip, "install_profile.json")?)
            .context("install_profile.json de Forge invalide")?;
        let version = read_entry(&mut zip, "version.json")?;
        extract_dir(&mut zip, "maven", &libs)?;
        Ok((profile, version))
    })
    .await??;
    let version: VersionJson =
        serde_json::from_str(&version_raw).context("version.json de Forge invalide")?;

    let mut items = Vec::new();
    for lib in profile.libraries.iter().chain(&version.libraries) {
        if let Some(a) = lib.downloads.as_ref().and_then(|d| d.artifact.as_ref()) {
            if a.url.is_empty() {
                continue;
            }
            let rel = match &a.path {
                Some(p) => p.clone(),
                None => maven::path(&lib.name)?,
            };
            items.push(DownloadItem {
                url: a.url.clone(),
                path: ctx.paths.libraries().join(rel),
                sha1: a.sha1.clone(),
                size: a.size,
            });
        }
    }
    ctx.ensure(items).await?;

    let version_dir = ctx.paths.version_dir(&id);
    tokio::fs::create_dir_all(&version_dir).await?;
    let marker = version_dir.join(".pl-installed");
    let installer_hash = match installer_sha1 {
        Some(sha1) => sha1,
        None => {
            let p = installer.clone();
            tokio::task::spawn_blocking(move || integrity::hash_file(&p)).await??
        }
    };
    let up_to_date = tokio::fs::read_to_string(&marker)
        .await
        .is_ok_and(|m| m.trim().eq_ignore_ascii_case(&installer_hash));
    let outputs_missing = vanilla::libraries(&version, &ctx.paths)?.iter().any(|l| !l.path.exists());

    if !up_to_date || outputs_missing {
        let (paths, java, inst, mc) = (ctx.paths.clone(), java.to_owned(), installer.clone(), mc.clone());
        tokio::task::spawn_blocking(move || run_processors(&profile, &paths, &inst, &mc, &java))
            .await??;
        tokio::fs::write(&marker, &installer_hash).await?;
    } else {
        tracing::info!("Forge {id} déjà installé");
    }

    tokio::fs::write(version_dir.join(format!("{id}.json")), &version_raw).await?;
    // Le launcher officiel place une copie du jar vanilla sous le nom de la
    // version Forge ; Forge l'exclut lui-même via `-DignoreList`.
    let jar = version_dir.join(format!("{id}.jar"));
    let vanilla_jar = ctx.paths.version_dir(&mc).join(format!("{mc}.jar"));
    let len = |p: &PathBuf| fs::metadata(p).map(|m| m.len()).ok();
    if len(&jar) != len(&vanilla_jar) {
        tokio::fs::copy(&vanilla_jar, &jar).await?;
    }

    let missing: Vec<String> = vanilla::libraries(&version, &ctx.paths)?
        .into_iter()
        .filter(|l| !l.path.exists())
        .map(|l| l.name)
        .collect();
    if !missing.is_empty() {
        bail!("bibliothèques Forge manquantes après installation : {}", missing.join(", "));
    }
    Ok(ForgeInstall { id, version })
}

async fn fetch_sha1(ctx: &Ctx, url: &str) -> Option<String> {
    let resp = ctx.client.get(url).send().await.ok()?.error_for_status().ok()?;
    let text = resp.text().await.ok()?;
    let sha1 = text.trim();
    (sha1.len() == 40 && sha1.bytes().all(|b| b.is_ascii_hexdigit())).then(|| sha1.to_owned())
}

fn run_processors(
    profile: &InstallProfile,
    paths: &GamePaths,
    installer: &Path,
    mc: &str,
    java: &Path,
) -> Result<()> {
    let libdir = paths.libraries();
    let tmp = paths.tmp().join("forge-installer");
    fs::create_dir_all(&tmp)?;
    let mut zip = open_zip(installer)?;

    let mut vars: HashMap<String, String> = HashMap::from([
        ("SIDE".into(), "client".into()),
        ("MINECRAFT_JAR".into(), paths.version_dir(mc).join(format!("{mc}.jar")).display().to_string()),
        ("MINECRAFT_VERSION".into(), mc.into()),
        ("ROOT".into(), paths.root().display().to_string()),
        ("INSTALLER".into(), installer.display().to_string()),
        ("LIBRARY_DIR".into(), libdir.display().to_string()),
    ]);
    for (key, value) in &profile.data {
        let value = &value.client;
        let resolved = if let Some(coord) = unwrap(value, '[', ']') {
            libdir.join(maven::path(coord)?).display().to_string()
        } else if let Some(literal) = unwrap(value, '\'', '\'') {
            literal.to_owned()
        } else if let Some(entry) = value.strip_prefix('/') {
            let dest = tmp.join(entry);
            extract_file(&mut zip, entry, &dest)?;
            dest.display().to_string()
        } else {
            value.clone()
        };
        vars.insert(key.clone(), resolved);
    }

    let client: Vec<&Processor> = profile
        .processors
        .iter()
        .filter(|p| p.sides.as_ref().is_none_or(|s| s.iter().any(|x| x == "client")))
        .collect();
    for (n, processor) in client.iter().enumerate() {
        let outputs = processor
            .outputs
            .iter()
            .map(|(file, sha1)| Ok((substitute(file, &vars, &libdir)?, substitute(sha1, &vars, &libdir)?)))
            .collect::<Result<Vec<_>>>()?;
        let outputs_ok = !outputs.is_empty()
            && outputs.iter().all(|(file, sha1)| {
                integrity::hash_file(Path::new(file)).is_ok_and(|h| h.eq_ignore_ascii_case(sha1))
            });
        if outputs_ok {
            continue;
        }

        let jar = libdir.join(maven::path(&processor.jar)?);
        let main_class = main_class(&jar)?;
        let mut classpath = vec![jar.display().to_string()];
        for entry in &processor.classpath {
            classpath.push(libdir.join(maven::path(entry)?).display().to_string());
        }
        let args = processor
            .args
            .iter()
            .map(|a| substitute(a, &vars, &libdir))
            .collect::<Result<Vec<_>>>()?;

        tracing::info!("Forge : étape {}/{} ({})", n + 1, client.len(), processor.jar);
        let mut cmd = Command::new(java);
        cmd.arg("-cp").arg(classpath.join(CP_SEP)).arg(&main_class).args(&args).current_dir(paths.root());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().with_context(|| format!("impossible de lancer {}", java.display()))?;
        if !out.status.success() {
            bail!("l'étape Forge {} a échoué ({}) :\n{}", processor.jar, out.status, tail(&out.stdout, &out.stderr));
        }
        for (file, sha1) in &outputs {
            if !integrity::hash_file(Path::new(file)).is_ok_and(|h| h.eq_ignore_ascii_case(sha1)) {
                bail!("fichier produit par Forge invalide : {file}");
            }
        }
    }
    let _ = fs::remove_dir_all(&tmp);
    Ok(())
}

fn unwrap(value: &str, open: char, close: char) -> Option<&str> {
    value.strip_prefix(open)?.strip_suffix(close)
}

/// Remplace `[coordonnée Maven]` par le chemin de la bibliothèque et les
/// `{VARIABLE}` par leur valeur.
fn substitute(arg: &str, vars: &HashMap<String, String>, libdir: &Path) -> Result<String> {
    if let Some(coord) = unwrap(arg, '[', ']') {
        return Ok(libdir.join(maven::path(coord)?).display().to_string());
    }
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(start) = rest.find('{') {
        let Some(len) = rest[start..].find('}') else { break };
        let key = &rest[start + 1..start + len];
        out.push_str(&rest[..start]);
        match vars.get(key) {
            Some(value) => out.push_str(value),
            None => out.push_str(&rest[start..=start + len]),
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    Ok(out)
}

fn tail(stdout: &[u8], stderr: &[u8]) -> String {
    let text = format!("{}\n{}", String::from_utf8_lossy(stdout), String::from_utf8_lossy(stderr));
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(40)..].join("\n")
}

fn open_zip(path: &Path) -> Result<zip::ZipArchive<fs::File>> {
    let file = fs::File::open(path).with_context(|| format!("ouverture de {}", path.display()))?;
    zip::ZipArchive::new(file).with_context(|| format!("archive invalide : {}", path.display()))
}

fn read_entry(zip: &mut zip::ZipArchive<fs::File>, name: &str) -> Result<String> {
    let mut entry = zip.by_name(name).with_context(|| format!("{name} absent de l'installateur Forge"))?;
    let mut out = String::new();
    entry.read_to_string(&mut out)?;
    Ok(out)
}

fn extract_file(zip: &mut zip::ZipArchive<fs::File>, name: &str, dest: &Path) -> Result<()> {
    let mut entry = zip.by_name(name).with_context(|| format!("{name} absent de l'installateur Forge"))?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)?;
    }
    std::io::copy(&mut entry, &mut fs::File::create(dest)?)?;
    Ok(())
}

/// Extrait le contenu du dossier `dir` de l'archive dans `dest`.
fn extract_dir(zip: &mut zip::ZipArchive<fs::File>, dir: &str, dest: &Path) -> Result<()> {
    for i in 0..zip.len() {
        let mut entry = zip.by_index(i)?;
        if entry.is_dir() {
            continue;
        }
        // `enclosed_name` refuse les chemins qui sortiraient du dossier cible.
        let Some(rel) = entry.enclosed_name().and_then(|p| p.strip_prefix(dir).ok().map(Path::to_owned))
        else {
            continue;
        };
        let target = dest.join(rel);
        if fs::metadata(&target).is_ok_and(|m| m.len() == entry.size()) {
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)?;
        }
        std::io::copy(&mut entry, &mut fs::File::create(&target)?)?;
    }
    Ok(())
}

fn main_class(jar: &Path) -> Result<String> {
    let mut zip = open_zip(jar)?;
    let manifest = read_entry(&mut zip, "META-INF/MANIFEST.MF")?;
    // Les lignes longues du manifest continuent sur la suivante, préfixée
    // d'une espace.
    let mut joined = String::new();
    for line in manifest.lines() {
        match line.strip_prefix(' ') {
            Some(continued) => joined.push_str(continued),
            None => {
                joined.push('\n');
                joined.push_str(line);
            }
        }
    }
    joined
        .lines()
        .find_map(|l| l.strip_prefix("Main-Class:"))
        .map(|s| s.trim().to_owned())
        .with_context(|| format!("pas de Main-Class dans {}", jar.display()))
}
