//! Fabrique l'installateur final : ajoute le launcher compressé (et, si
//! fourni, le bootstrapper WebView2) à la fin de l'exe d'installation.
//!
//! pl-pack --setup <installateur.exe> --launcher <launcher.exe>
//!         --version <x.y.z> --out <final.exe> [--webview2 <bootstrapper.exe>]

#[path = "../overlay.rs"]
#[allow(dead_code)]
mod overlay;

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::PathBuf;

fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let (mut setup, mut launcher, mut version, mut out, mut webview2) = (None, None, None, None, None);
    while let Some(flag) = args.next() {
        let value = args.next().with_context(|| format!("valeur manquante après {flag}"))?;
        match flag.as_str() {
            "--setup" => setup = Some(PathBuf::from(value)),
            "--launcher" => launcher = Some(PathBuf::from(value)),
            "--version" => version = Some(value),
            "--out" => out = Some(PathBuf::from(value)),
            "--webview2" => webview2 = Some(PathBuf::from(value)),
            _ => bail!("option inconnue : {flag}"),
        }
    }
    let (Some(setup), Some(launcher), Some(version), Some(out)) = (setup, launcher, version, out) else {
        bail!("usage : pl-pack --setup <exe> --launcher <exe> --version <x.y.z> --out <exe> [--webview2 <exe>]");
    };
    if version.len() > 24 {
        bail!("version trop longue");
    }

    let stub = std::fs::read(&setup).with_context(|| format!("lecture de {}", setup.display()))?;
    if overlay::Footer::parse(&stub[stub.len().saturating_sub(96)..]).is_some() {
        bail!("{} contient déjà un launcher", setup.display());
    }
    let raw = std::fs::read(&launcher).with_context(|| format!("lecture de {}", launcher.display()))?;
    let wv2 = match &webview2 {
        Some(path) => std::fs::read(path).with_context(|| format!("lecture de {}", path.display()))?,
        None => Vec::new(),
    };

    // Niveau 19 avec fenêtre longue : proche de LZMA, décompression très rapide.
    let mut encoder = zstd::bulk::Compressor::new(19)?;
    encoder.set_parameter(zstd::zstd_safe::CParameter::EnableLongDistanceMatching(true))?;
    encoder.set_parameter(zstd::zstd_safe::CParameter::WindowLog(26))?;
    encoder.set_parameter(zstd::zstd_safe::CParameter::NbWorkers(4))?;
    let compressed = encoder.compress(&raw)?;

    let footer = overlay::Footer {
        payload_len: compressed.len() as u64,
        raw_len: raw.len() as u64,
        webview2_len: wv2.len() as u64,
        sha256: Sha256::digest(&raw).into(),
        version,
    };
    let tmp = out.with_extension("part");
    {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(&stub)?;
        file.write_all(&compressed)?;
        file.write_all(&wv2)?;
        file.write_all(&footer.to_bytes())?;
        file.sync_all()?;
    }
    std::fs::rename(&tmp, &out)?;

    let mb = |n: usize| n as f64 / 1_048_576.0;
    println!("Installateur : {}", out.display());
    println!("  programme d'installation : {:.1} Mo", mb(stub.len()));
    println!("  launcher : {:.1} Mo -> {:.1} Mo compressé", mb(raw.len()), mb(compressed.len()));
    if !wv2.is_empty() {
        println!("  bootstrapper WebView2 : {:.1} Mo", mb(wv2.len()));
    }
    println!("  total : {:.1} Mo", mb(stub.len() + compressed.len() + wv2.len() + 96));
    Ok(())
}
