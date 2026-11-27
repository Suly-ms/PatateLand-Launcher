//! Mises à jour : GitHub simulé (wiremock), manifeste signé avec une clé de test.

use base64::{Engine, engine::general_purpose::STANDARD as B64};
use ed25519_dalek::{Signer, SigningKey};
use pl_engine::update::{self, Manifest, ManifestFile};
use serde_json::json;
use sha2::{Digest, Sha256};
use wiremock::matchers::{method, path};
use wiremock::{Mock, MockServer, ResponseTemplate};

const REPO_LATEST: &str = "/repos/Suly-ms/PatateLand-Launcher/releases/latest";

struct Fake {
    server: MockServer,
    public: String,
    installer: Vec<u8>,
}

/// Release 2.0.0 avec installateur, manifeste et signature. `tamper` : le
/// fichier servi n'est pas celui du manifeste (installateur remplacé).
async fn release(tamper: bool, sign_with: u8) -> Fake {
    let server = MockServer::start().await;
    let key = SigningKey::from_bytes(&[3u8; 32]);
    let public = B64.encode(key.verifying_key().to_bytes());
    let installer: Vec<u8> = (0..50_000u32).map(|i| (i % 251) as u8).collect();
    let name = format!("PatateLand-{}-setup.bin", update::platform());

    let mut manifest = Manifest { version: "2.0.0".into(), notes: "Nouveautés".into(), files: Default::default() };
    manifest.files.insert(
        update::platform(),
        ManifestFile { name: name.clone(), sha256: hex::encode(Sha256::digest(&installer)), size: installer.len() as u64 },
    );
    let manifest = serde_json::to_vec(&manifest).unwrap();
    let signer = SigningKey::from_bytes(&[sign_with; 32]);
    let signature = B64.encode(signer.sign(&manifest).to_bytes());

    let url = |n: &str| format!("{}/download/{n}", server.uri());
    Mock::given(method("GET"))
        .and(path(REPO_LATEST))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "tag_name": "2.0.0", "draft": false, "prerelease": false,
            "assets": [
                { "name": name, "browser_download_url": url(&name) },
                { "name": update::MANIFEST, "browser_download_url": url(update::MANIFEST) },
                { "name": update::SIGNATURE, "browser_download_url": url(update::SIGNATURE) },
            ]
        })))
        .mount(&server)
        .await;
    let served = if tamper {
        let mut bad = installer.clone();
        bad[100] ^= 0xff;
        bad
    } else {
        installer.clone()
    };
    Mock::given(path(format!("/download/{name}"))).respond_with(ResponseTemplate::new(200).set_body_bytes(served)).mount(&server).await;
    Mock::given(path(format!("/download/{}", update::MANIFEST))).respond_with(ResponseTemplate::new(200).set_body_bytes(manifest)).mount(&server).await;
    Mock::given(path(format!("/download/{}", update::SIGNATURE))).respond_with(ResponseTemplate::new(200).set_body_string(signature)).mount(&server).await;
    Fake { server, public, installer }
}

#[tokio::test]
async fn finds_downloads_and_verifies_an_update() {
    let fake = release(false, 3).await;
    let client = reqwest::Client::new();
    let found = update::check_with_key(&client, &fake.server.uri(), "0.1.0", &fake.public).await.unwrap().unwrap();
    assert_eq!(found.version, "2.0.0");
    assert_eq!(found.notes, "Nouveautés");

    let dir = tempfile::tempdir().unwrap();
    let mut last = (0, 0);
    let file = update::download(&client, &found, dir.path(), |d, t| last = (d, t)).await.unwrap();
    assert_eq!(std::fs::read(&file).unwrap(), fake.installer);
    assert_eq!(last, (fake.installer.len() as u64, fake.installer.len() as u64));

    // Déjà à jour : rien.
    assert!(update::check_with_key(&client, &fake.server.uri(), "2.0.0", &fake.public).await.unwrap().is_none());
}

#[tokio::test]
async fn replaced_installer_is_refused_and_deleted() {
    let fake = release(true, 3).await;
    let client = reqwest::Client::new();
    let found = update::check_with_key(&client, &fake.server.uri(), "0.1.0", &fake.public).await.unwrap().unwrap();
    let dir = tempfile::tempdir().unwrap();
    assert!(update::download(&client, &found, dir.path(), |_, _| {}).await.is_err());
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0, "aucun fichier gardé");
}

#[tokio::test]
async fn manifest_signed_by_someone_else_is_refused() {
    let fake = release(false, 9).await;
    let client = reqwest::Client::new();
    assert!(update::check_with_key(&client, &fake.server.uri(), "0.1.0", &fake.public).await.is_err());
}

#[tokio::test]
async fn old_electron_release_is_ignored() {
    let server = MockServer::start().await;
    Mock::given(path(REPO_LATEST))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({
            "tag_name": "1.4.2",
            "assets": [{ "name": "PatateLand-win.exe", "browser_download_url": "http://x/y" }, { "name": "latest.yml", "browser_download_url": "http://x/z" }]
        })))
        .mount(&server)
        .await;
    let client = reqwest::Client::new();
    assert!(update::check(&client, &server.uri(), "0.1.0").await.unwrap().is_none());
}
