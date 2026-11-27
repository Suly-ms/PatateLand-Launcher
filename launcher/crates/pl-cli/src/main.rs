//! Outil de test du moteur : installe une instance (Java, Minecraft, Forge,
//! fichiers du serveur), la lance, et mesure la vérification des fichiers.
//!
//! Tout est écrit dans `--root` (par défaut `run/game`, dans ce projet).

use std::{
    path::PathBuf,
    process::ExitCode,
    sync::{Arc, Mutex, OnceLock, atomic::Ordering},
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use clap::{Args, Parser, Subcommand};
use pl_engine::{
    Ctx,
    auth::{
        Account,
        azauth::{AzAuth, Login},
        microsoft::{DEFAULT_CLIENT_ID, Endpoints, Microsoft},
        store::{AccountKind, AccountStatus, AccountStore},
    },
    forge,
    game::{self, Event, Installed, Plan, RunOptions},
    integrity::{self, VerifyMode},
    java,
    net::{DownloadItem, Progress},
    packs::{self, PackKind},
    remote, servers_dat,
    settings::{self, Settings},
    storage,
    vanilla::{self, VersionJson},
};

#[derive(Parser)]
#[command(about = "Prototype du moteur PatateLand en Rust")]
struct Cli {
    /// Dossier de jeu (isolé de l'ancien launcher).
    #[arg(long, default_value = "run/game", global = true)]
    root: PathBuf,
    /// Serveur de fichiers PatateLand.
    #[arg(long, default_value = remote::DEFAULT_SERVER, global = true)]
    server: String,
    /// Téléchargements simultanés.
    #[arg(long, default_value_t = 8, global = true)]
    concurrency: usize,
    /// Dossier des comptes (isolé de l'ancien launcher).
    #[arg(long, default_value = "run/data", global = true)]
    data: PathBuf,
    /// Écrit les mesures de la commande dans ce fichier JSON (protocole PatateBench).
    #[arg(long, global = true)]
    report: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Affiche la configuration et les instances du serveur PatateLand.
    Info,
    /// Installe ou répare une instance.
    Install(InstallArgs),
    /// Installe puis lance une instance.
    Launch {
        #[command(flatten)]
        install: InstallArgs,
        /// Compte enregistré (identifiant ou pseudo, voir `account list`).
        #[arg(long, conflicts_with = "name")]
        account: Option<String>,
        /// Pseudo d'un compte hors-ligne temporaire (non enregistré).
        #[arg(long)]
        name: Option<String>,
        /// RAM du jeu en Mo (sinon : réglages, ou recommandation pour ce PC).
        #[arg(long)]
        ram_min: Option<u32>,
        #[arg(long)]
        ram_max: Option<u32>,
        /// Argument Java supplémentaire (répétable), ex. `--jvm-arg=-XX:+UseZGC`.
        #[arg(long = "jvm-arg", allow_hyphen_values = true)]
        jvm_args: Vec<String>,
        /// Ferme le jeu dès que le menu principal est chargé (test automatique).
        #[arg(long)]
        exit_when_ready: bool,
    },
    /// Compare les trois méthodes de vérification des fichiers installés.
    VerifyBench(InstallArgs),
    /// Gestion des comptes.
    #[command(subcommand)]
    Account(AccountCommand),
    /// Réglages du launcher.
    #[command(subcommand)]
    Settings(SettingsCommand),
    /// Resource packs et shaders d'une instance.
    Packs {
        #[arg(long, default_value = "Opti")]
        instance: String,
        /// `resource` ou `shader`.
        #[arg(long, default_value = "resource")]
        kind: String,
        /// Copie ce fichier .zip dans l'instance.
        #[arg(long, conflicts_with = "remove")]
        add: Option<PathBuf>,
        /// Supprime ce pack (nom de fichier).
        #[arg(long)]
        remove: Option<String>,
    },
    /// Fichiers mis en quarantaine (archives invalides) : liste et restauration.
    Quarantine {
        /// Remet ce fichier à sa place (identifiant affiché par la liste).
        #[arg(long)]
        restore: Option<String>,
    },
    /// Espace disque utilisé, et nettoyage.
    Storage {
        /// Vide les logs de cette instance.
        #[arg(long)]
        clear_logs: Option<String>,
        /// Vide le cache Minecraft (assets, bibliothèques, versions).
        #[arg(long)]
        clear_cache: bool,
    },
    /// Publication : manifeste et signature des mises à jour (utilisé par la
    /// compilation automatique GitHub).
    #[command(subcommand)]
    Release(ReleaseCommand),
}

#[derive(Subcommand)]
enum ReleaseCommand {
    /// Écrit patateland-update.json : version et SHA-256 de chaque installateur.
    Manifest {
        #[arg(long)]
        version: String,
        /// Notes de version (texte).
        #[arg(long, default_value = "")]
        notes: String,
        /// plateforme=chemin, ex. windows-x86_64=dist/PatateLand-win-x64-setup.exe
        #[arg(long = "file", required = true)]
        files: Vec<String>,
        #[arg(long)]
        out: PathBuf,
    },
    /// Signe un manifeste avec la clé privée lue dans PL_UPDATE_SIGNING_KEY
    /// (base64) ; écrit <manifeste>.sig.
    Sign { manifest: PathBuf },
    /// Crée une nouvelle paire de clés (la clé privée est écrite dans un fichier).
    Keygen {
        #[arg(long)]
        private_out: PathBuf,
    },
}

#[derive(Subcommand)]
enum SettingsCommand {
    /// Affiche les réglages et la RAM recommandée pour ce PC.
    Show,
    /// Modifie un réglage : `settings set fullscreen true`, `settings set memory '{"min_gb":2,"max_gb":6}'`.
    Set { key: String, value: String },
    /// Revient aux réglages par défaut.
    Reset,
}

#[derive(Subcommand)]
enum AccountCommand {
    /// Liste les comptes et leur état.
    List,
    /// Vérifie tous les comptes auprès de leur service (sans jamais en supprimer).
    Refresh,
    /// Ajoute un compte hors-ligne.
    AddOffline {
        #[arg(long)]
        name: String,
    },
    /// Connexion AZauth (site PatateLand). Mot de passe et code A2F demandés au clavier.
    AddAzauth {
        /// URL du site (valeur `online` de /config).
        #[arg(long)]
        site: String,
        #[arg(long)]
        email: String,
    },
    /// Connexion Microsoft : ouvre la page Microsoft, puis colle l'adresse finale.
    AddMicrosoft {
        #[arg(long)]
        client_id: Option<String>,
    },
    /// Choisit le compte par défaut.
    Select { account: String },
    /// Supprime un compte (action explicite uniquement).
    Remove { account: String },
}

#[derive(Args, Clone)]
struct InstallArgs {
    #[arg(long, default_value = "Opti")]
    instance: String,
    /// Version de Minecraft (obligatoire si le serveur PatateLand est injoignable).
    #[arg(long)]
    mc: Option<String>,
    /// Version de Forge : `latest`, `recommended` ou un numéro (ex. 47.4.16).
    #[arg(long)]
    forge: Option<String>,
    /// Manifest des fichiers de l'instance (URL ou fichier local).
    #[arg(long)]
    manifest: Option<String>,
    /// Revérifie le SHA-1 de tous les fichiers (mode « Réparer »).
    #[arg(long)]
    full_verify: bool,
    /// Sans serveur : fichiers que le joueur peut modifier (comme `ignored`).
    #[arg(long)]
    ignored: Vec<String>,
    /// Sans serveur : supprime les fichiers absents du manifest (comme `verify: true`).
    #[arg(long)]
    clean: bool,
}

#[tokio::main]
async fn main() -> ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "info,reqwest=warn,hyper=warn".into()),
        )
        .with_target(false)
        .without_time()
        .init();

    let started = *START.get_or_init(Instant::now);
    let cli = Cli::parse();
    let report_path = cli.report.clone();
    let result = run(cli).await;
    print_footer(started.elapsed());
    metric("succes", result.is_ok());
    if let Some(path) = report_path {
        if let Err(e) = write_report(&path) {
            eprintln!("Rapport non écrit : {e:#}");
        }
    }
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("\nErreur : {e:#}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<()> {
    // Outils de publication : sans dossier de jeu.
    if let Command::Release(command) = &cli.command {
        return release_command(command);
    }
    let mut ctx = Ctx::new(cli.root.clone(), cli.concurrency)?;
    println!("Dossier de jeu : {}", ctx.paths.root().display());
    let result = match &cli.command {
        Command::Info => info(&ctx, &cli.server).await,
        Command::Install(args) => {
            ctx.verify_mode = verify_mode(args);
            let plan = plan(&ctx, &cli.server, &cli.data, args).await?;
            install(&ctx, plan).await.map(|_| ())
        }
        Command::Account(command) => accounts(&ctx, &cli.data, command).await,
        Command::Launch { install: args, account, name, ram_min, ram_max, jvm_args, exit_when_ready } => {
            ctx.verify_mode = verify_mode(args);
            let account = match (account, name) {
                (_, Some(name)) => Account::offline(name)?,
                (selector, None) => {
                    let mut store = AccountStore::open(&cli.data)?;
                    refresh_and_report(&ctx, &mut store).await?;
                    let chosen = match selector {
                        Some(s) => store.find(s).with_context(|| format!("compte « {s} » introuvable"))?,
                        None => store.selected().context("aucun compte : utilise `account add-...` ou --name")?,
                    };
                    let id = chosen.id.clone();
                    if let AccountStatus::Unverified(reason) = &chosen.status {
                        println!("⚠ {} non vérifié ({reason}) : dernière session connue utilisée", chosen.name);
                    }
                    store.game_account(&id)?
                }
            };
            let settings = Settings::load(&cli.data.join("settings.json"))?;
            let total = settings::total_memory_gb();
            let memory = match (ram_min, ram_max) {
                (Some(min), Some(max)) => {
                    let allowed = (settings::max_allowed_gb(total) * 1024.0) as u32;
                    if *min == 0 || min > max || *max > allowed {
                        bail!("RAM invalide : {min}-{max} Mo (maximum {allowed} Mo sur ce PC)");
                    }
                    (*min, *max)
                }
                _ => {
                    let m = settings.effective_memory(total);
                    (m.min_mb(), m.max_mb())
                }
            };
            let mut plan = plan(&ctx, &cli.server, &cli.data, args).await?;
            plan.jvm_args.extend(jvm_args.iter().cloned());
            let installed = install(&ctx, plan).await?;
            ctx.integrity.save()?;
            game::run(&ctx, &installed, &settings, account, RunOptions { memory_mb: memory, exit_when_ready: *exit_when_ready }, &print_event)
                .await
                .map(|_| ())
        }
        Command::VerifyBench(args) => {
            let plan = plan(&ctx, &cli.server, &cli.data, args).await?;
            verify_bench(&ctx, plan).await
        }
        Command::Settings(command) => settings_command(&cli.data.join("settings.json"), command),
        Command::Packs { instance, kind, add, remove } => {
            let kind = match kind.as_str() {
                "resource" => PackKind::Resource,
                "shader" => PackKind::Shader,
                other => bail!("type de pack inconnu : {other} (resource ou shader)"),
            };
            let dir = ctx.paths.instance(instance);
            if let Some(source) = add {
                println!("Ajouté : {}", packs::import(&dir, kind, source)?);
            }
            if let Some(name) = remove {
                packs::remove(&dir, kind, name)?;
                println!("Supprimé : {name}");
            }
            for p in packs::list(&dir, kind)? {
                println!("  {:<50} {}", p.name, if p.is_folder { "dossier".into() } else { mb(p.size) });
            }
            Ok(())
        }
        Command::Quarantine { restore } => {
            let q = pl_engine::quarantine::Quarantine::new(ctx.paths.state_dir().join("quarantine"));
            if let Some(id) = restore {
                let entry = q.list()?.into_iter().find(|e| &e.id == id).with_context(|| format!("aucune entrée « {id} »"))?;
                let restored = q.restore(id, &ctx.paths.instance(&entry.instance))?;
                println!("Restauré : {}", restored.display());
            }
            let entries = q.list()?;
            if entries.is_empty() {
                println!("Quarantaine vide.");
            }
            for e in entries {
                println!("  [{}] {} / {} ({}) : {}", e.id, e.instance, e.original, mb(e.size), e.reason);
            }
            Ok(())
        }
        // Traité au début de run(), sans dossier de jeu.
        Command::Release(_) => unreachable!(),
        Command::Storage { clear_logs, clear_cache } => {
            if let Some(instance) = clear_logs {
                let locked = storage::clear_logs(&ctx.paths, instance);
                println!("Logs de {instance} vidés ({locked} fichier(s) en cours d'utilisation ignoré(s))");
            }
            if *clear_cache {
                let locked = storage::clear_cache(&ctx.paths);
                println!("Cache vidé ({locked} élément(s) en cours d'utilisation ignoré(s))");
            }
            let t = Instant::now();
            let o = storage::overview(&ctx.paths, &cli.data).await?;
            for (label, size) in [
                ("Logs", o.logs),
                ("Comptes", o.accounts),
                ("Ressources partagées", o.shared),
                ("Runtime Java", o.runtime),
                ("Instances", o.instances),
                ("Autre", o.other),
                ("Total", o.total()),
            ] {
                println!("  {label:<22} {}", mb(size));
            }
            println!("  (calculé en {:.2} s)", t.elapsed().as_secs_f64());
            Ok(())
        }
    };
    ctx.integrity.save()?;
    result
}

fn mb(bytes: u64) -> String {
    format!("{:.1} Mo", bytes as f64 / 1_048_576.0)
}

fn settings_command(path: &std::path::Path, command: &SettingsCommand) -> Result<()> {
    let total = settings::total_memory_gb();
    let mut current = Settings::load(path)?;
    match command {
        SettingsCommand::Show => {}
        SettingsCommand::Reset => {
            current = Settings::default();
            current.save(path)?;
        }
        SettingsCommand::Set { key, value } => {
            // Passage par JSON : la même validation que l'interface utilisera.
            let mut json = serde_json::to_value(&current)?;
            let parsed = serde_json::from_str(value).unwrap_or_else(|_| serde_json::Value::String(value.clone()));
            let field = json.get_mut(key.as_str()).with_context(|| format!("réglage inconnu : {key}"))?;
            *field = parsed;
            let updated: Settings = serde_json::from_value(json).with_context(|| format!("valeur invalide pour {key}"))?;
            updated.validate(total)?;
            updated.save(path)?;
            current = updated;
        }
    }
    println!("{}", serde_json::to_string_pretty(&current)?);
    let rec = settings::recommended_memory(total);
    let eff = current.effective_memory(total);
    println!("\nRAM du PC : {total:.1} Go, recommandé : {} Go mini / {} Go maxi", rec.min_gb, rec.max_gb);
    println!("RAM utilisée au lancement : {} Mo / {} Mo", eff.min_mb(), eff.max_mb());
    if total < settings::LOW_RAM_WARNING_GB {
        println!("⚠ Moins de {} Go de RAM : l'instance Opti est conseillée.", settings::LOW_RAM_WARNING_GB);
    }
    Ok(())
}

async fn accounts(ctx: &Ctx, data: &std::path::Path, command: &AccountCommand) -> Result<()> {
    let mut store = AccountStore::open(data)?;
    match command {
        AccountCommand::List => {}
        AccountCommand::Refresh => refresh_and_report(ctx, &mut store).await?,
        AccountCommand::AddOffline { name } => {
            store.add_offline(name)?;
        }
        AccountCommand::AddAzauth { site, email } => {
            let az = AzAuth::new(&ctx.client, site)?;
            let password = rpassword::prompt_password("Mot de passe : ")?;
            let mut login = az.login(email, &password, None).await?;
            if matches!(login, Login::TwoFactorRequired) {
                let code = prompt("Code A2F : ")?;
                login = az.login(email, &password, Some(&code)).await?;
            }
            let Login::Success(user) = login else { bail!("le site redemande un code A2F") };
            let skin = az.skin_url(user.id);
            store.add_azauth(site, &user, Some(skin));
        }
        AccountCommand::AddMicrosoft { client_id } => {
            let ms = Microsoft::new(&ctx.client, client_id.as_deref(), Endpoints::default());
            println!("1. Ouvre cette adresse dans ton navigateur et connecte-toi :\n\n{}\n", ms.authorize_url());
            println!("2. Tu arrives sur une page blanche : copie son adresse complète.");
            let redirect = prompt("Adresse de la page blanche : ")?;
            let session = ms.login_with_code(&Microsoft::code_from_redirect(&redirect)?).await?;
            store.add_microsoft(client_id.as_deref().unwrap_or(DEFAULT_CLIENT_ID), &session);
        }
        AccountCommand::Select { account } => {
            let id = store.find(account).with_context(|| format!("compte « {account} » introuvable"))?.id.clone();
            store.select(&id)?;
        }
        AccountCommand::Remove { account } => {
            let id = store.find(account).with_context(|| format!("compte « {account} » introuvable"))?.id.clone();
            store.remove(&id);
            println!("Compte supprimé.");
        }
    }
    store.save()?;
    print_accounts(&store);
    Ok(())
}

async fn refresh_and_report(ctx: &Ctx, store: &mut AccountStore) -> Result<()> {
    let started = Instant::now();
    let reports = store.refresh_all(&ctx.client, &Endpoints::default()).await;
    // Sauvegardé tout de suite : un token renouvelé ne doit pas être perdu.
    store.save()?;
    if !reports.is_empty() {
        println!("{} compte(s) vérifié(s) en {:.2} s", reports.len(), started.elapsed().as_secs_f64());
    }
    Ok(())
}

fn print_accounts(store: &AccountStore) {
    if store.accounts().is_empty() {
        println!("Aucun compte.");
        return;
    }
    let selected = store.selected().map(|a| a.id.clone());
    for a in store.accounts() {
        let kind = match &a.kind {
            AccountKind::AZauth { .. } => "AZauth",
            AccountKind::Microsoft { .. } => "Microsoft",
            AccountKind::Offline => "hors-ligne",
            AccountKind::MojangLegacy => "Mojang (ancien)",
        };
        let status = match &a.status {
            AccountStatus::Valid => "✔ valide".to_owned(),
            AccountStatus::Unverified(r) => format!("⚠ non vérifié ({r})"),
            AccountStatus::NeedsRelogin(r) => format!("✖ reconnexion nécessaire ({r})"),
        };
        let mark = if selected.as_deref() == Some(a.id.as_str()) { "*" } else { " " };
        println!("{mark} {:<16} {:<10} {:<38} {}  [{}]", a.name, kind, a.uuid, status, a.id);
    }
}

fn prompt(label: &str) -> Result<String> {
    use std::io::Write;
    print!("{label}");
    std::io::stdout().flush()?;
    let mut line = String::new();
    std::io::stdin().read_line(&mut line)?;
    Ok(line.trim().to_owned())
}

fn verify_mode(args: &InstallArgs) -> VerifyMode {
    if args.full_verify { VerifyMode::Full } else { VerifyMode::Fast }
}

async fn info(ctx: &Ctx, server: &str) -> Result<()> {
    let config = remote::fetch_config(&ctx.client, server).await.context("lecture de /config")?;
    println!("{config:#?}");
    for i in remote::fetch_instances(&ctx.client, server).await.context("lecture de /files")? {
        println!(
            "- {} : Minecraft {} {} {} (verify={}, whitelist={})",
            i.name,
            i.loader.minecraft_version,
            i.loader.loader_type.as_deref().unwrap_or("vanilla"),
            i.loader.loader_version.as_deref().unwrap_or(""),
            i.verify,
            i.whitelist_active,
        );
    }
    Ok(())
}

/// Lit l'instance sur le serveur PatateLand ; si celui-ci est injoignable,
/// se rabat sur `--mc` / `--forge`.
async fn plan(ctx: &Ctx, server: &str, data: &std::path::Path, args: &InstallArgs) -> Result<Plan> {
    if let Some(info) = game::fetch_instance(ctx, server, &args.instance, &data.join("remote-cache.json")).await {
        let mut plan = Plan::from_info(info)?;
        if let Some(mc) = &args.mc {
            plan.mc = mc.clone();
        }
        if args.forge.is_some() {
            plan.forge = args.forge.clone();
        }
        if args.manifest.is_some() {
            plan.manifest = args.manifest.clone();
        }
        return Ok(plan);
    }

    let Some(mc) = args.mc.clone() else {
        bail!(
            "instance « {} » introuvable : ni le serveur ni la copie locale ne la connaissent. \
             Une première connexion au serveur est nécessaire (ou --mc et --forge pour un test sans serveur).",
            args.instance
        );
    };
    println!("Mode sans serveur : Minecraft {mc}, Forge {}", args.forge.as_deref().unwrap_or("aucun"));
    Ok(Plan {
        server: servers_dat::default_server(&args.instance),
        instance: args.instance.clone(),
        mc,
        forge: args.forge.clone(),
        manifest: args.manifest.clone(),
        clean: args.clean,
        ignored: args.ignored.clone(),
        jvm_args: Vec::new(),
        game_args: Vec::new(),
    })
}

async fn install(ctx: &Ctx, plan: Plan) -> Result<Installed> {
    let printer = spawn_progress(ctx.progress.clone());
    let result = game::install(ctx, plan, &print_event).await;
    printer.abort();
    result
}

/// Affichage des événements du moteur, et mesures pour `--report`.
fn print_event(event: Event) {
    match event {
        Event::Step { label } => println!("\n▶ {label}"),
        Event::Checked { label, files, check_s, downloaded, bytes, download_s } => {
            let key = label.to_lowercase().replace(", ", "_").replace(' ', "_");
            metric(&format!("{key}.fichiers"), files);
            metric(&format!("{key}.verification_s"), check_s);
            metric(&format!("{key}.telecharges"), downloaded);
            metric(&format!("{key}.octets"), bytes);
            metric(&format!("{key}.telechargement_s"), download_s);
            println!(
                "  {label} : {files} fichiers vérifiés en {check_s:.2} s, {downloaded} téléchargé(s) ({:.1} Mo en {download_s:.1} s)",
                bytes as f64 / 1_048_576.0,
            );
        }
        Event::ForgeReady { seconds, .. } => {
            println!("  Forge prêt en {seconds:.1} s");
            metric("forge_s", seconds);
        }
        Event::InstanceSynced { removed, quarantined, suspicious } => {
            if removed > 0 {
                println!("  {removed} fichier(s) en trop supprimé(s)");
            }
            if quarantined > 0 {
                println!("  {quarantined} fichier(s) mis en quarantaine (voir `pl-cli quarantine`)");
            }
            if suspicious > 0 {
                println!("  {suspicious} archive(s) illisible(s) laissée(s) en place");
            }
        }
        Event::NoManifest => println!("\n(aucun manifest d'instance : mods non synchronisés)"),
        Event::Offline { detail } => println!("  ⚠ Hors connexion : {detail}"),
        Event::Installed { seconds } => {
            println!("\n✔ Installation prête en {seconds:.1} s");
            metric("installation_s", seconds);
        }
        Event::Memory { min_mb, max_mb } => println!("\n  RAM du jeu : {min_mb} Mo mini / {max_mb} Mo maxi"),
        Event::ServerInjected { name, ip } => println!("  Serveur « {name} » ({ip}) en tête de la liste multijoueur"),
        Event::JavaStarted { pid } => {
            println!("  Processus Java démarré (PID {pid})");
            metric("jouer_vers_processus_java_s", since_start());
        }
        Event::Log { line } => println!("  [jeu] {line}"),
        Event::MenuReached { seconds } => {
            println!("\n✔ Menu principal atteint en {seconds:.1} s après le lancement");
            metric("jouer_vers_menu_s", since_start());
            metric("processus_java_vers_menu_s", seconds);
            if let Some(mb) = memory_mb(false) {
                metric("ram_moteur_jeu_lance_mo", mb);
            }
        }
        Event::Exited { code, crash } => {
            println!("  Jeu fermé (code {code:?})");
            if let Some(crash) = crash {
                println!("\n✖ Le jeu s'est arrêté anormalement (code {code:?})");
                match (&crash.report, &crash.queued) {
                    (None, _) => println!("  Aucun rapport de crash écrit par le jeu."),
                    (Some(report), Some(queued)) => {
                        println!("  Rapport : {}", report.display());
                        println!("  Rapport préparé pour l'envoi (en attente de la route du site) : {}", queued.display());
                    }
                    (Some(report), None) => {
                        println!("  Rapport : {}", report.display());
                        println!("  Envoi des rapports désactivé dans les réglages : rien n'est envoyé.");
                    }
                }
            }
        }
    }
}

/// Mesure la vérification des fichiers déjà installés :
/// 1. comme l'ancien launcher (SHA-1 de chaque fichier, un par un) ;
/// 2. SHA-1 de chaque fichier, en parallèle ;
/// 3. avec l'index (seuls les fichiers modifiés sont relus).
async fn verify_bench(ctx: &Ctx, plan: Plan) -> Result<()> {
    let vanilla = vanilla::load_version(ctx, &plan.mc).await?;
    let component = vanilla
        .java_version
        .as_ref()
        .map_or_else(|| "java-runtime-gamma".to_owned(), |j| j.component.clone());
    let mut items: Vec<DownloadItem> = java::resolve(ctx, &component).await?.items;
    items.extend(vanilla::base_items(&vanilla, &ctx.paths)?);
    items.extend(vanilla::asset_items(ctx, &vanilla).await?);
    if let Some(requested) = &plan.forge {
        let version = forge::resolve_version(ctx, &plan.mc, requested).await?;
        let id = format!("{}-forge-{version}", plan.mc);
        let raw = tokio::fs::read_to_string(ctx.paths.version_dir(&id).join(format!("{id}.json")))
            .await
            .context("Forge non installé : lance d'abord `install`")?;
        let forge: VersionJson = serde_json::from_str(&raw)?;
        items.extend(vanilla::libraries(&forge, &ctx.paths)?.into_iter().filter_map(|l| l.download));
    }
    let count = items.len();
    let bytes: u64 = items.iter().filter_map(|i| i.size).sum();
    println!("\n{count} fichiers, {:.0} Mo", bytes as f64 / 1_048_576.0);

    let cpus = ctx.hash_parallelism;
    for (label, mode, parallelism) in [
        ("Comme l'ancien launcher (un par un)", VerifyMode::Full, 1),
        ("SHA-1 complet en parallèle", VerifyMode::Full, cpus),
        ("Index (nouveau launcher)", VerifyMode::Fast, cpus),
    ] {
        let t = Instant::now();
        let missing = integrity::filter_missing(items.clone(), ctx.integrity.clone(), mode, parallelism, None).await?;
        let elapsed = t.elapsed();
        println!("  {label:<38} {:>7.2} s  ({} à télécharger)", elapsed.as_secs_f64(), missing.len());
    }
    println!("\nNote : les deux dernières mesures profitent du cache disque de Windows rempli par la première.");
    Ok(())
}

/// Début de la commande : équivalent du clic sur JOUER pour les mesures.
static START: OnceLock<Instant> = OnceLock::new();
static METRICS: Mutex<Vec<(String, serde_json::Value)>> = Mutex::new(Vec::new());

fn metric(key: &str, value: impl Into<serde_json::Value>) {
    METRICS.lock().unwrap().push((key.to_owned(), value.into()));
}

fn since_start() -> f64 {
    START.get().map_or(0.0, |s| s.elapsed().as_secs_f64())
}

fn write_report(path: &std::path::Path) -> Result<()> {
    let mut map = serde_json::Map::new();
    map.insert("launcher".into(), "nouveau (moteur Rust, pl-cli)".into());
    map.insert("version".into(), env!("CARGO_PKG_VERSION").into());
    map.insert("args".into(), std::env::args().skip(1).collect::<Vec<_>>().join(" ").into());
    for (key, value) in METRICS.lock().unwrap().drain(..) {
        map.insert(key, value);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, serde_json::to_vec_pretty(&map)?)?;
    println!("Mesures écrites dans {}", path.display());
    Ok(())
}

fn spawn_progress(progress: Arc<Progress>) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut last = 0;
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            let done = progress.done_bytes.load(Ordering::Relaxed);
            if done == last {
                continue;
            }
            last = done;
            println!(
                "  … {:.1} / {:.1} Mo ({} / {} fichiers)",
                done as f64 / 1_048_576.0,
                progress.total_bytes.load(Ordering::Relaxed) as f64 / 1_048_576.0,
                progress.done_files.load(Ordering::Relaxed),
                progress.total_files.load(Ordering::Relaxed),
            );
        }
    })
}

fn print_footer(elapsed: Duration) {
    metric("duree_totale_s", elapsed.as_secs_f64());
    match memory_mb(true) {
        Some(mb) => {
            metric("ram_max_moteur_mo", mb);
            println!("\n[durée totale {:.1} s, mémoire max du launcher {mb:.1} Mo]", elapsed.as_secs_f64())
        }
        None => println!("\n[durée totale {:.1} s]", elapsed.as_secs_f64()),
    }
}

/// Mémoire du processus (working set), actuelle ou maximale.
#[cfg(windows)]
fn memory_mb(peak: bool) -> Option<f64> {
    use windows_sys::Win32::System::{
        ProcessStatus::{GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS},
        Threading::GetCurrentProcess,
    };
    // SAFETY: structure initialisée à zéro avec sa taille, pointeur valide
    // pendant tout l'appel.
    unsafe {
        let mut counters: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
        counters.cb = size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
        (GetProcessMemoryInfo(GetCurrentProcess(), &mut counters, counters.cb) != 0).then(|| {
            let bytes = if peak { counters.PeakWorkingSetSize } else { counters.WorkingSetSize };
            bytes as f64 / 1_048_576.0
        })
    }
}

#[cfg(not(windows))]
fn memory_mb(_peak: bool) -> Option<f64> {
    None
}

// ---------- Publication des mises à jour ----------

fn release_command(command: &ReleaseCommand) -> Result<()> {
    use base64::{Engine, engine::general_purpose::STANDARD as B64};
    use ed25519_dalek::{Signer, SigningKey};
    use pl_engine::update::{Manifest, ManifestFile};
    use sha2::{Digest, Sha256};

    match command {
        ReleaseCommand::Manifest { version, notes, files, out } => {
            let mut manifest = Manifest { version: version.clone(), notes: notes.clone(), files: Default::default() };
            for entry in files {
                let (platform, path) = entry.split_once('=').context("--file attend plateforme=chemin")?;
                let path = PathBuf::from(path);
                let bytes = std::fs::read(&path).with_context(|| format!("lecture de {}", path.display()))?;
                let name = path.file_name().context("nom de fichier")?.to_string_lossy().into_owned();
                manifest.files.insert(
                    platform.to_owned(),
                    ManifestFile { name, sha256: hex::encode(Sha256::digest(&bytes)), size: bytes.len() as u64 },
                );
            }
            std::fs::write(out, serde_json::to_vec_pretty(&manifest)?)?;
            println!("Manifeste écrit : {} ({} fichier(s))", out.display(), manifest.files.len());
        }
        ReleaseCommand::Sign { manifest } => {
            let secret = std::env::var("PL_UPDATE_SIGNING_KEY").context("variable PL_UPDATE_SIGNING_KEY absente")?;
            let seed: [u8; 32] = B64
                .decode(secret.trim())
                .ok()
                .and_then(|k| k.try_into().ok())
                .context("PL_UPDATE_SIGNING_KEY invalide (32 octets en base64 attendus)")?;
            let key = SigningKey::from_bytes(&seed);
            let public = B64.encode(key.verifying_key().to_bytes());
            if public != pl_engine::update::PUBLIC_KEY.trim() {
                bail!("cette clé privée ne correspond pas à la clé publique intégrée au launcher");
            }
            let bytes = std::fs::read(manifest)?;
            let signature = B64.encode(key.sign(&bytes).to_bytes());
            // Contrôle : la signature passe la même vérification que le launcher.
            pl_engine::update::verify_manifest(&bytes, &signature, &public)?;
            let out = PathBuf::from(format!("{}.sig", manifest.display()));
            std::fs::write(&out, &signature)?;
            println!("Signature écrite : {}", out.display());
        }
        ReleaseCommand::Keygen { private_out } => {
            if private_out.exists() {
                bail!("{} existe déjà : rien n'est écrasé", private_out.display());
            }
            let mut seed = [0u8; 32];
            getrandom::getrandom(&mut seed).map_err(|e| anyhow::anyhow!("{e}"))?;
            let key = SigningKey::from_bytes(&seed);
            std::fs::write(private_out, format!("{}\n", B64.encode(seed)))?;
            println!("Clé privée écrite dans {} (à garder secrète).", private_out.display());
            println!("Clé publique (crates/pl-engine/update-key.pub) : {}", B64.encode(key.verifying_key().to_bytes()));
        }
    }
    Ok(())
}
