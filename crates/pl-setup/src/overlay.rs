//! Contenu ajoutÃ© Ã  la fin de l'installateur (Â« overlay Â») :
//!
//! ```text
//! [launcher compressÃ© zstd][bootstrapper WebView2 (facultatif)][pied de 96 octets]
//! ```
//!
//! Windows ignore ces octets en fin d'exÃ©cutable. Le dÃ©sinstallateur est la
//! mÃªme exe **sans** cette partie : il pÃ¨se quelques Mo au lieu de dupliquer
//! tout le launcher sur le disque.

use anyhow::{Context, Result, bail};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

pub const MAGIC: &[u8; 8] = b"PLSETUP1";
pub const FOOTER_LEN: u64 = 96;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Footer {
    /// Taille du launcher compressÃ©.
    pub payload_len: u64,
    /// Taille du launcher une fois dÃ©compressÃ©.
    pub raw_len: u64,
    /// Taille du bootstrapper WebView2 (0 s'il n'est pas inclus).
    pub webview2_len: u64,
    /// SHA-256 du launcher dÃ©compressÃ©.
    pub sha256: [u8; 32],
    /// Version du launcher (ex. Â« 0.1.0 Â»).
    pub version: String,
}

impl Footer {
    #[cfg_attr(not(test), allow(dead_code))] // utilisé par pl-pack et les tests
    pub fn to_bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(FOOTER_LEN as usize);
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&self.payload_len.to_le_bytes());
        out.extend_from_slice(&self.raw_len.to_le_bytes());
        out.extend_from_slice(&self.webview2_len.to_le_bytes());
        out.extend_from_slice(&self.sha256);
        let mut version = [0u8; 24];
        let bytes = self.version.as_bytes();
        version[..bytes.len().min(24)].copy_from_slice(&bytes[..bytes.len().min(24)]);
        out.extend_from_slice(&version);
        out.resize(FOOTER_LEN as usize, 0);
        out
    }

    pub fn parse(bytes: &[u8]) -> Option<Self> {
        if bytes.len() != FOOTER_LEN as usize || &bytes[..8] != MAGIC {
            return None;
        }
        let u64_at = |i: usize| u64::from_le_bytes(bytes[i..i + 8].try_into().unwrap());
        let version = &bytes[64..88];
        let end = version.iter().position(|&b| b == 0).unwrap_or(version.len());
        Some(Self {
            payload_len: u64_at(8),
            raw_len: u64_at(16),
            webview2_len: u64_at(24),
            sha256: bytes[32..64].try_into().unwrap(),
            version: String::from_utf8_lossy(&version[..end]).into_owned(),
        })
    }

    /// Taille totale ajoutÃ©e Ã  la fin de l'exe.
    pub fn overlay_len(&self) -> u64 {
        self.payload_len + self.webview2_len + FOOTER_LEN
    }
}

/// Contenu lu depuis un installateur.
pub struct Overlay {
    pub footer: Footer,
    /// Taille de l'exe sans l'overlay (= le dÃ©sinstallateur).
    pub stub_len: u64,
}

/// Lit le pied de l'exe. `None` : installateur fabriquÃ© sans launcher
/// (compilation de dÃ©veloppement).
pub fn read(exe: &Path) -> Result<Option<Overlay>> {
    let mut file = File::open(exe).with_context(|| format!("lecture de {}", exe.display()))?;
    let len = file.metadata()?.len();
    if len < FOOTER_LEN {
        return Ok(None);
    }
    file.seek(SeekFrom::Start(len - FOOTER_LEN))?;
    let mut buf = vec![0u8; FOOTER_LEN as usize];
    file.read_exact(&mut buf)?;
    let Some(footer) = Footer::parse(&buf) else { return Ok(None) };
    let Some(stub_len) = len.checked_sub(footer.overlay_len()) else {
        bail!("installateur endommagÃ© (taille incohÃ©rente)");
    };
    Ok(Some(Overlay { footer, stub_len }))
}

impl Overlay {
    /// DÃ©compresse le launcher en vÃ©rifiant sa taille et son empreinte.
    /// `progress` reÃ§oit une valeur entre 0 et 1.
    pub fn extract(&self, exe: &Path, out: &mut impl std::io::Write, mut progress: impl FnMut(f64)) -> Result<()> {
        let mut file = File::open(exe)?;
        file.seek(SeekFrom::Start(self.stub_len))?;
        let compressed = file.take(self.footer.payload_len);
        let mut decoder = zstd::stream::read::Decoder::new(compressed).context("launcher compressÃ© illisible")?;
        let mut hasher = Sha256::new();
        let mut buf = vec![0u8; 1 << 20];
        let mut done = 0u64;
        loop {
            let n = decoder.read(&mut buf).context("installateur endommagÃ© : dÃ©compression impossible")?;
            if n == 0 {
                break;
            }
            hasher.update(&buf[..n]);
            out.write_all(&buf[..n])?;
            done += n as u64;
            progress((done as f64 / self.footer.raw_len.max(1) as f64).min(1.0));
        }
        if done != self.footer.raw_len || hasher.finalize().as_slice() != self.footer.sha256 {
            bail!("installateur endommagÃ© : le launcher ne correspond pas Ã  l'original. TÃ©lÃ©charge-le Ã  nouveau.");
        }
        Ok(())
    }

    /// Bootstrapper WebView2 inclus, s'il y en a un.
    pub fn webview2(&self, exe: &Path) -> Result<Option<Vec<u8>>> {
        if self.footer.webview2_len == 0 {
            return Ok(None);
        }
        let mut file = File::open(exe)?;
        file.seek(SeekFrom::Start(self.stub_len + self.footer.payload_len))?;
        let mut data = vec![0u8; self.footer.webview2_len as usize];
        file.read_exact(&mut data)?;
        Ok(Some(data))
    }

    /// Copie l'exe sans l'overlay : c'est le dÃ©sinstallateur.
    pub fn write_stub(&self, exe: &Path, out: &mut impl std::io::Write) -> Result<()> {
        let mut file = File::open(exe)?.take(self.stub_len);
        std::io::copy(&mut file, out)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn footer_round_trip() {
        let footer = Footer { payload_len: 12, raw_len: 34, webview2_len: 5, sha256: [7; 32], version: "0.1.0".into() };
        assert_eq!(Footer::parse(&footer.to_bytes()), Some(footer));
        assert_eq!(Footer::parse(&[0u8; 96]), None);
    }

    fn build(dir: &Path, launcher: &[u8], tamper: bool) -> std::path::PathBuf {
        let exe = dir.join("setup.exe");
        let mut file = File::create(&exe).unwrap();
        file.write_all(b"MZ-stub-de-test").unwrap();
        let compressed = zstd::bulk::compress(launcher, 3).unwrap();
        let mut payload = compressed.clone();
        if tamper {
            // MÃªme taille, contenu diffÃ©rent aprÃ¨s dÃ©compression.
            payload = zstd::bulk::compress(&vec![b'x'; launcher.len()], 3).unwrap();
        }
        file.write_all(&payload).unwrap();
        file.write_all(b"WV2").unwrap();
        let footer = Footer {
            payload_len: payload.len() as u64,
            raw_len: launcher.len() as u64,
            webview2_len: 3,
            sha256: Sha256::digest(launcher).into(),
            version: "1.2.3".into(),
        };
        file.write_all(&footer.to_bytes()).unwrap();
        exe
    }

    #[test]
    fn extract_and_stub() {
        let dir = tempfile::tempdir().unwrap();
        let launcher: Vec<u8> = (0..300_000u32).map(|i| (i % 251) as u8).collect();
        let exe = build(dir.path(), &launcher, false);
        let overlay = read(&exe).unwrap().unwrap();
        assert_eq!(overlay.footer.version, "1.2.3");

        let mut out = Vec::new();
        let mut last = 0.0;
        overlay.extract(&exe, &mut out, |p| last = p).unwrap();
        assert_eq!(out, launcher);
        assert_eq!(last, 1.0);

        let mut stub = Vec::new();
        overlay.write_stub(&exe, &mut stub).unwrap();
        assert_eq!(stub, b"MZ-stub-de-test");
        assert_eq!(overlay.webview2(&exe).unwrap().unwrap(), b"WV2");
    }

    #[test]
    fn tampered_payload_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let exe = build(dir.path(), &[1, 2, 3, 4, 5, 6, 7, 8], true);
        let overlay = read(&exe).unwrap().unwrap();
        assert!(overlay.extract(&exe, &mut Vec::new(), |_| {}).is_err());
    }

    #[test]
    fn exe_without_overlay() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("plain.exe");
        std::fs::write(&exe, vec![0u8; 500]).unwrap();
        assert!(read(&exe).unwrap().is_none());
    }
}
