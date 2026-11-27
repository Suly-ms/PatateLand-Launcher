//! Construction de la ligne de commande Java et lancement du jeu.

use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    process::Stdio,
};

use anyhow::{Result, bail};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt, AsyncRead, BufReader},
    process::{Child, Command},
    sync::mpsc,
};

use crate::{
    CP_SEP,
    auth::Account,
    forge::ForgeInstall,
    maven,
    paths::GamePaths,
    rules,
    vanilla::{self, ResolvedLibrary, VersionJson},
};

pub struct LaunchOptions {
    /// `javaw.exe` du runtime (ou Java choisi par le joueur).
    pub java: PathBuf,
    pub instance_dir: PathBuf,
    pub account: Account,
    pub memory_min_mb: u32,
    pub memory_max_mb: u32,
    pub width: u32,
    pub height: u32,
    pub fullscreen: bool,
    /// Arguments propres à l'instance (`jvm_args` / `game_args` du serveur).
    pub extra_jvm: Vec<String>,
    pub extra_game: Vec<String>,
}

pub struct Prepared {
    pub program: PathBuf,
    pub args: Vec<String>,
    pub cwd: PathBuf,
}

/// Mêmes réglages du ramasse-miettes que le launcher actuel.
const GC_FLAGS: [&str; 5] = [
    "-XX:+UnlockExperimentalVMOptions",
    "-XX:G1NewSizePercent=20",
    "-XX:G1ReservePercent=20",
    "-XX:MaxGCPauseMillis=50",
    "-XX:G1HeapRegionSize=32M",
];

pub fn prepare(
    paths: &GamePaths,
    vanilla: &VersionJson,
    forge: Option<&ForgeInstall>,
    opts: &LaunchOptions,
) -> Result<Prepared> {
    let mc = &vanilla.id;
    let version_name = forge.map_or_else(|| mc.clone(), |f| f.id.clone());

    // Bibliothèques Forge d'abord : en cas de doublon, sa version l'emporte.
    let mut seen = HashSet::new();
    let mut classpath = Vec::new();
    let mut missing = Vec::new();
    if let Some(forge) = forge {
        add_libraries(vanilla::libraries(&forge.version, paths)?, &mut seen, &mut classpath, &mut missing);
    }
    add_libraries(vanilla::libraries(vanilla, paths)?, &mut seen, &mut classpath, &mut missing);
    let jar = paths.version_dir(&version_name).join(format!("{version_name}.jar"));
    if !jar.exists() {
        missing.push(jar.display().to_string());
    }
    classpath.push(jar.display().to_string());
    if !missing.is_empty() {
        bail!("fichiers manquants, relance l'installation : {}", missing.join(", "));
    }

    let natives = paths.natives(mc);
    std::fs::create_dir_all(&natives)?;
    let account = &opts.account;
    let vars: HashMap<&str, String> = HashMap::from([
        ("natives_directory", natives.display().to_string()),
        ("launcher_name", "PatateLand".to_owned()),
        ("launcher_version", env!("CARGO_PKG_VERSION").to_owned()),
        ("classpath", classpath.join(CP_SEP)),
        ("classpath_separator", CP_SEP.to_owned()),
        ("library_directory", paths.libraries().display().to_string()),
        ("version_name", version_name.clone()),
        ("game_directory", opts.instance_dir.display().to_string()),
        ("assets_root", paths.assets().display().to_string()),
        ("game_assets", paths.assets().display().to_string()),
        ("assets_index_name", vanilla.asset_index.as_ref().map_or_else(String::new, |a| a.id.clone())),
        ("auth_player_name", account.name.clone()),
        ("auth_uuid", account.uuid.clone()),
        ("auth_access_token", account.access_token.clone()),
        ("auth_session", account.access_token.clone()),
        ("auth_xuid", account.xuid.clone()),
        ("clientid", account.client_id.clone()),
        ("user_type", account.user_type.clone()),
        ("user_properties", account.user_properties.clone()),
        ("version_type", vanilla.kind.clone().unwrap_or_else(|| "release".to_owned())),
    ]);

    let mut jvm: Vec<String> = vec![
        format!("-Xms{}M", opts.memory_min_mb),
        format!("-Xmx{}M", opts.memory_max_mb),
    ];
    jvm.extend(GC_FLAGS.iter().map(|s| s.to_string()));
    jvm.push("-Dfml.ignoreInvalidMinecraftCertificates=true".into());
    jvm.extend(resolve_args(&vanilla.arguments.jvm));
    if let Some(client) = vanilla.logging.as_ref().and_then(|l| l.client.as_ref()) {
        let config = paths.assets().join("log_configs").join(&client.file.id);
        jvm.push(client.argument.replace("${path}", &file_url(&config)));
    }
    if let Some(forge) = forge {
        jvm.extend(resolve_args(&forge.version.arguments.jvm));
    }
    jvm.extend(opts.extra_jvm.iter().cloned());

    let mut game = resolve_args(&vanilla.arguments.game);
    if let Some(forge) = forge {
        game.extend(resolve_args(&forge.version.arguments.game));
    }
    if opts.fullscreen {
        game.push("--fullscreen".into());
    } else {
        game.extend(["--width".into(), opts.width.to_string(), "--height".into(), opts.height.to_string()]);
    }
    game.extend(opts.extra_game.iter().cloned());

    let main_class = forge.map_or(&vanilla.main_class, |f| &f.version.main_class);
    let mut args: Vec<String> = jvm.iter().map(|a| expand(a, &vars)).collect();
    args.push(main_class.clone());
    args.extend(game.iter().map(|a| expand(a, &vars)));
    Ok(Prepared { program: opts.java.clone(), args, cwd: opts.instance_dir.clone() })
}

fn add_libraries(
    libs: Vec<ResolvedLibrary>,
    seen: &mut HashSet<String>,
    classpath: &mut Vec<String>,
    missing: &mut Vec<String>,
) {
    for lib in libs {
        if !seen.insert(maven::dedup_key(&lib.name)) {
            continue;
        }
        if !lib.path.exists() {
            missing.push(lib.name);
        }
        classpath.push(lib.path.display().to_string());
    }
}

/// Aplatit une liste d'arguments Mojang (chaînes ou objets conditionnels).
fn resolve_args(values: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        match value {
            Value::String(s) => out.push(s.clone()),
            Value::Object(obj) => {
                let rules: Option<Vec<rules::Rule>> =
                    obj.get("rules").and_then(|r| serde_json::from_value(r.clone()).ok());
                if !rules::allowed(rules.as_deref()) {
                    continue;
                }
                match obj.get("value") {
                    Some(Value::String(s)) => out.push(s.clone()),
                    Some(Value::Array(items)) => {
                        out.extend(items.iter().filter_map(|v| v.as_str().map(str::to_owned)))
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }
    out
}

/// Remplace les `${variable}` connues ; les autres restent telles quelles.
fn expand(arg: &str, vars: &HashMap<&str, String>) -> String {
    let mut out = String::with_capacity(arg.len());
    let mut rest = arg;
    while let Some(start) = rest.find("${") {
        let Some(len) = rest[start..].find('}') else { break };
        out.push_str(&rest[..start]);
        match vars.get(&rest[start + 2..start + len]) {
            Some(value) => out.push_str(value),
            None => out.push_str(&rest[start..=start + len]),
        }
        rest = &rest[start + len + 1..];
    }
    out.push_str(rest);
    out
}

/// log4j interprète `C:/...` comme une URL de protocole « c » : on lui donne
/// une vraie URL `file:///`.
fn file_url(path: &Path) -> String {
    let s = path.display().to_string().replace('\\', "/").replace('%', "%25").replace(' ', "%20");
    if s.starts_with('/') { format!("file://{s}") } else { format!("file:///{s}") }
}

pub fn spawn(prepared: &Prepared) -> Result<Child> {
    std::fs::create_dir_all(&prepared.cwd)?;
    Ok(Command::new(&prepared.program)
        .args(&prepared.args)
        .current_dir(&prepared.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?)
}

/// Lignes de sortie (stdout et stderr) du jeu.
pub fn output_lines(child: &mut Child) -> mpsc::UnboundedReceiver<String> {
    let (tx, rx) = mpsc::unbounded_channel();
    if let Some(stdout) = child.stdout.take() {
        forward(stdout, tx.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        forward(stderr, tx);
    }
    rx
}

fn forward(reader: impl AsyncRead + Unpin + Send + 'static, tx: mpsc::UnboundedSender<String>) {
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
}
