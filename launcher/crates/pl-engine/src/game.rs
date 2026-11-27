//! Parcours complet du bouton JOUER : instance → installation (Java,
//! Minecraft, Forge, fichiers de l'instance) → lancement → suivi du jeu.
//!
//! Partagé par l'outil en ligne de commande et l'interface : l'avancement est
//! signalé par des [`Event`], chaque interface les affiche à sa façon.

use std::{
    path::PathBuf,
    time::{Duration, Instant, SystemTime},
};

use anyhow::{Result, bail};
use serde::Serialize;

use crate::{
    Ctx, EnsureReport,
    auth::Account,
    crash,
    forge::{self, ForgeInstall},
    instance,
    java::{self, JavaRuntime},
    launch::{self, LaunchOptions},
    remote::{self, InstanceInfo},
    servers_dat::{self, ServerEntry},
    settings::Settings,
    vanilla::{self, VersionJson},
};

/// Ce qu'il faut installer pour une instance.
#[derive(Debug, Clone)]
pub struct Plan {
    pub instance: String,
    pub mc: String,
    pub forge: Option<String>,
    pub manifest: Option<String>,
    /// `verify` du serveur : supprimer les fichiers absents du manifest.
    pub clean: bool,
    pub ignored: Vec<String>,
    pub jvm_args: Vec<String>,
    pub game_args: Vec<String>,
    /// Serveur à placer en tête de la liste multijoueur.
    pub server: Option<ServerEntry>,
}

impl Plan {
    /// Plan d'une instance décrite par le serveur PatateLand (`/files`).
    pub fn from_info(info: InstanceInfo) -> Result<Self> {
        let forge = match info.loader.loader_type.as_deref() {
            None | Some("none") => None,
            Some("forge") => Some(info.loader.loader_version.clone().unwrap_or_else(|| "latest".into())),
            Some(other) => bail!("chargeur « {other} » pas encore pris en charge"),
        };
        let server = info
            .status
            .as_ref()
            .and_then(servers_dat::from_status)
            .or_else(|| servers_dat::default_server(&info.name));
        Ok(Self {
            server,
            instance: info.name,
            mc: info.loader.minecraft_version,
            forge,
            manifest: info.url,
            clean: info.verify,
            ignored: info.ignored,
            jvm_args: info.jvm_args,
            game_args: info.game_args,
        })
    }
}

/// Récupère l'instance `name` sur le serveur, ou dans la dernière copie
/// locale s'il est injoignable (`None` si aucune des deux ne la connaît).
pub async fn fetch_instance(ctx: &Ctx, server: &str, name: &str, cache: &std::path::Path) -> Option<InstanceInfo> {
    match remote::fetch_or_cached(&ctx.client, server, cache).await {
        Ok((snapshot, _)) => snapshot.instances.into_iter().find(|i| i.name.eq_ignore_ascii_case(name)),
        Err(e) => {
            tracing::warn!("{e:#}");
            None
        }
    }
}

/// Avancement, pour l'affichage. La progression des téléchargements se lit
/// à part, dans `ctx.progress` (compteurs sans verrou).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    Step { label: String },
    Checked { label: String, files: usize, check_s: f64, downloaded: usize, bytes: u64, download_s: f64 },
    ForgeReady { version: String, seconds: f64 },
    InstanceSynced { removed: usize, quarantined: usize, suspicious: usize },
    NoManifest,
    /// Serveur ou service injoignable : les fichiers déjà installés sont utilisés.
    Offline { detail: String },
    Installed { seconds: f64 },
    ServerInjected { name: String, ip: String },
    Memory { min_mb: u32, max_mb: u32 },
    JavaStarted { pid: u32 },
    Log { line: String },
    MenuReached { seconds: f64 },
    Exited { code: Option<i32>, crash: Option<CrashInfo> },
}

#[derive(Debug, Clone, Serialize)]
pub struct CrashInfo {
    /// Rapport écrit par le jeu, s'il y en a un.
    pub report: Option<PathBuf>,
    /// Rapport préparé pour l'envoi (si l'option est activée).
    pub queued: Option<PathBuf>,
}

pub type Emit<'a> = &'a (dyn Fn(Event) + Send + Sync);

fn checked(label: &str, r: &EnsureReport) -> Event {
    Event::Checked {
        label: label.to_owned(),
        files: r.checked,
        check_s: r.check_time.as_secs_f64(),
        downloaded: r.downloaded,
        bytes: r.bytes,
        download_s: r.download_time.as_secs_f64(),
    }
}

pub struct Installed {
    pub vanilla: VersionJson,
    pub forge: Option<ForgeInstall>,
    pub java: JavaRuntime,
    pub instance_dir: PathBuf,
    pub plan: Plan,
}

pub async fn install(ctx: &Ctx, plan: Plan, emit: Emit<'_>) -> Result<Installed> {
    let started = Instant::now();
    emit(Event::Step { label: format!("Minecraft {}", plan.mc) });
    let vanilla = vanilla::load_version(ctx, &plan.mc).await?;
    let component = vanilla
        .java_version
        .as_ref()
        .map_or_else(|| "java-runtime-gamma".to_owned(), |j| j.component.clone());
    let java = match java::resolve(ctx, &component).await {
        Ok(java) => java,
        Err(e) => {
            // Hors connexion : le Java déjà installé suffit.
            let installed = JavaRuntime::installed(ctx.paths.runtime().join(&component));
            if !installed.javaw().exists() {
                return Err(e.context("Java n'est pas encore installé et le service de Mojang est injoignable"));
            }
            emit(Event::Offline { detail: "Java déjà installé utilisé".into() });
            installed
        }
    };
    let mut items = java.items.clone();
    items.extend(vanilla::base_items(&vanilla, &ctx.paths)?);
    items.extend(vanilla::asset_items(ctx, &vanilla).await?);
    emit(checked("Java, Minecraft et assets", &ctx.ensure(items).await?));
    java.prepare()?;

    let forge = match &plan.forge {
        Some(requested) => {
            let version = match forge::resolve_version(ctx, &plan.mc, requested).await {
                Ok(version) => version,
                Err(e) => match forge::installed_versions(&ctx.paths, &plan.mc).into_iter().next() {
                    Some(version) => {
                        emit(Event::Offline { detail: format!("Forge {version} déjà installé utilisé") });
                        version
                    }
                    None => return Err(e.context("Forge n'est pas encore installé et son serveur est injoignable")),
                },
            };
            emit(Event::Step { label: format!("Forge {version}") });
            let t = Instant::now();
            let forge = forge::install(ctx, &vanilla, &version, &java.java()).await?;
            emit(Event::ForgeReady { version, seconds: t.elapsed().as_secs_f64() });
            Some(forge)
        }
        None => None,
    };

    let instance_dir = ctx.paths.instance(&plan.instance);
    tokio::fs::create_dir_all(&instance_dir).await?;
    match &plan.manifest {
        Some(source) => {
            emit(Event::Step { label: format!("Fichiers de l'instance {}", plan.instance) });
            let synced_marker = ctx.paths.state_dir().join("synced").join(&plan.instance);
            match remote::fetch_manifest(&ctx.client, source).await {
                Ok(files) => {
                    let sync = instance::sync(ctx, &instance_dir, &files, &plan.ignored, plan.clean).await?;
                    emit(checked("Instance", &sync.ensure));
                    emit(Event::InstanceSynced {
                        removed: sync.removed.len(),
                        quarantined: sync.quarantined.len(),
                        suspicious: sync.suspicious.len(),
                    });
                    tokio::fs::create_dir_all(synced_marker.parent().expect("dossier parent")).await?;
                    tokio::fs::write(&synced_marker, crate::auth::microsoft::now().to_string()).await?;
                }
                // Serveur injoignable : on joue avec les fichiers déjà là, à
                // condition que l'instance ait été synchronisée au moins une fois.
                Err(e) if synced_marker.exists() => {
                    tracing::warn!("manifest de {} injoignable : {e:#}", plan.instance);
                    emit(Event::Offline { detail: format!("fichiers de {} non vérifiés auprès du serveur", plan.instance) });
                }
                Err(e) => {
                    return Err(e.context(format!(
                        "{} n'a jamais été installée sur ce PC : une connexion au serveur PatateLand est nécessaire la première fois",
                        plan.instance
                    )));
                }
            }
        }
        None => emit(Event::NoManifest),
    }

    ctx.integrity.save()?;
    emit(Event::Installed { seconds: started.elapsed().as_secs_f64() });
    Ok(Installed { vanilla, forge, java, instance_dir, plan })
}

pub struct RunOptions {
    pub memory_mb: (u32, u32),
    /// Ferme le jeu dès le menu principal (tests automatiques).
    pub exit_when_ready: bool,
}

#[derive(Debug, Clone)]
pub struct RunOutcome {
    pub reached_menu: bool,
    pub code: Option<i32>,
    pub crash: Option<CrashInfo>,
}

/// Lance le jeu et le suit jusqu'à sa fermeture.
pub async fn run(
    ctx: &Ctx,
    installed: &Installed,
    settings: &Settings,
    account: Account,
    options: RunOptions,
    emit: Emit<'_>,
) -> Result<RunOutcome> {
    let player = account.name.clone();
    let (min_mb, max_mb) = options.memory_mb;
    let launch_options = LaunchOptions {
        java: settings.java_path.clone().unwrap_or_else(|| installed.java.javaw()),
        instance_dir: installed.instance_dir.clone(),
        account,
        memory_min_mb: min_mb,
        memory_max_mb: max_mb,
        width: settings.width,
        height: settings.height,
        fullscreen: settings.fullscreen,
        extra_jvm: installed.plan.jvm_args.clone(),
        extra_game: installed.plan.game_args.clone(),
    };
    let prepared = launch::prepare(&ctx.paths, &installed.vanilla, installed.forge.as_ref(), &launch_options)?;
    tokio::fs::create_dir_all(ctx.paths.state_dir()).await?;
    tokio::fs::write(ctx.paths.state_dir().join("last-launch-args.txt"), prepared.args.join("\n")).await?;
    emit(Event::Memory { min_mb, max_mb });

    // Avant le lancement : Minecraft lit la liste au démarrage et la réécrit
    // lui-même ensuite. Un échec ne bloque jamais le jeu.
    if let Some(server) = &installed.plan.server {
        match servers_dat::inject(&installed.instance_dir, server) {
            Ok(_) => emit(Event::ServerInjected { name: server.name.clone(), ip: server.ip.clone() }),
            Err(e) => tracing::warn!("servers.dat non modifié : {e:#}"),
        }
    }

    emit(Event::Step { label: format!("Lancement de {}", installed.plan.instance) });
    let launched_at = SystemTime::now();
    let started = Instant::now();
    let mut child = launch::spawn(&prepared)?;
    emit(Event::JavaStarted { pid: child.id().unwrap_or(0) });
    let mut lines = launch::output_lines(&mut child);

    let mut ready = false;
    let deadline = tokio::time::sleep(Duration::from_secs(600));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            line = lines.recv() => {
                let Some(line) = line else { break };
                if let Some(text) = readable(&line) {
                    emit(Event::Log { line: text });
                }
                if !ready && line.contains("Sound engine started") {
                    ready = true;
                    emit(Event::MenuReached { seconds: started.elapsed().as_secs_f64() });
                    if options.exit_when_ready {
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        child.kill().await?;
                        break;
                    }
                }
            }
            _ = &mut deadline, if options.exit_when_ready && !ready => {
                child.kill().await?;
                bail!("le menu principal n'a pas été atteint en 10 minutes");
            }
        }
    }
    let status = child.wait().await?;
    // Fermeture demandée par un test : pas un crash.
    let killed_by_us = options.exit_when_ready && ready;
    let crash = if !status.success() && !killed_by_us {
        Some(crash_info(ctx, installed, settings, &player, status.code(), launched_at)?)
    } else {
        None
    };
    emit(Event::Exited { code: status.code(), crash: crash.clone() });
    if options.exit_when_ready && !ready {
        bail!("le jeu s'est arrêté avant d'atteindre le menu principal");
    }
    Ok(RunOutcome { reached_menu: ready, code: status.code(), crash })
}

/// Rapport de crash : retrouvé, nettoyé, et mis en attente d'envoi seulement
/// si le joueur l'a autorisé (la route du site n'existe pas encore).
fn crash_info(
    ctx: &Ctx,
    installed: &Installed,
    settings: &Settings,
    player: &str,
    code: Option<i32>,
    launched_at: SystemTime,
) -> Result<CrashInfo> {
    let Some(report) = crash::find_report(&installed.instance_dir, launched_at) else {
        return Ok(CrashInfo { report: None, queued: None });
    };
    let queued = if settings.send_crash_reports {
        let prepared = crash::prepare(&installed.plan.instance, player, code, &report)?;
        let queue = ctx.paths.state_dir().join("crash-queue");
        std::fs::create_dir_all(&queue)?;
        let file = queue.join(format!("{}.json", prepared.file_name.trim_end_matches(".txt")));
        std::fs::write(&file, serde_json::to_vec_pretty(&prepared)?)?;
        Some(file)
    } else {
        None
    };
    Ok(CrashInfo { report: Some(report), queued })
}

/// Les logs de Minecraft arrivent en XML log4j : on n'en garde que le texte.
pub fn readable(line: &str) -> Option<String> {
    let line = line.trim();
    if let Some(start) = line.find("<![CDATA[") {
        let rest = &line[start + 9..];
        return Some(rest[..rest.find("]]>").unwrap_or(rest.len())].to_owned());
    }
    if line.is_empty() || line.starts_with("<log4j:") || line.starts_with("</log4j:") {
        return None;
    }
    Some(line.to_owned())
}
