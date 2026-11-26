//! Réparation prudente des fausses archives (solution 2 validée pour les
//! 4 resource packs d'Extra) : quarantaine restaurable, et aucun fichier
//! valide ou modifié par le joueur n'est jamais touché.

use std::{fs, io::Write, path::PathBuf};

use pl_engine::{Ctx, instance, quarantine::Quarantine, remote::InstanceFile};
use sha1::{Digest, Sha1};
use wiremock::{Mock, MockServer, ResponseTemplate, matchers::path};

/// Le vrai contenu de la page 404 enregistrée par l'ancien launcher commence ainsi.
const PAGE_404: &[u8] = b"<html>\n<head>\n<title>404 Not Found</title></head><body>404</body></html>";

fn zip_with(content: &str) -> Vec<u8> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let mut w = zip::ZipWriter::new(&mut buf);
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    w.start_file("pack.mcmeta", opts).unwrap();
    w.write_all(content.as_bytes()).unwrap();
    w.finish().unwrap();
    buf.into_inner()
}

fn sha1(bytes: &[u8]) -> String {
    hex::encode(Sha1::digest(bytes))
}

struct Setup {
    root: PathBuf,
    instance: PathBuf,
    ctx: Ctx,
    official: Vec<u8>,
    files: Vec<InstanceFile>,
    _server: MockServer,
}

async fn setup(name: &str) -> Setup {
    let root = std::env::temp_dir().join(format!("pl-instance-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let instance = root.join("instances").join("Extra");
    fs::create_dir_all(instance.join("resourcepacks")).unwrap();

    let official = zip_with("{\"pack\":{\"description\":\"officiel\"}}");
    let server = MockServer::start().await;
    Mock::given(path("/Nebula.zip"))
        .respond_with(ResponseTemplate::new(200).set_body_bytes(official.clone()))
        .mount(&server)
        .await;
    let files = vec![InstanceFile {
        path: Some("resourcepacks/Nebula.zip".into()),
        hash: Some(sha1(&official)),
        size: Some(official.len() as u64),
        url: format!("{}/Nebula.zip", server.uri()),
    }];
    let ctx = Ctx::new(root.clone(), 4).unwrap();
    Setup { root, instance, ctx, official, files, _server: server }
}

const IGNORED: &[&str] = &["resourcepacks", "options.txt"];

fn ignored() -> Vec<String> {
    IGNORED.iter().map(|s| s.to_string()).collect()
}

#[tokio::test]
async fn page_404_in_place_of_official_pack_is_quarantined_and_replaced() {
    let s = setup("404").await;
    let pack = s.instance.join("resourcepacks/Nebula.zip");
    fs::write(&pack, PAGE_404).unwrap();

    let report = instance::sync(&s.ctx, &s.instance, &s.files, &ignored(), true).await.unwrap();
    assert_eq!(fs::read(&pack).unwrap(), s.official, "le vrai pack doit être installé");
    assert_eq!(report.quarantined.len(), 1);

    // La fausse archive est conservée, hors de l'instance, et restaurable.
    let q = Quarantine::new(s.root.join(".pl/quarantine"));
    let entries = q.list().unwrap();
    assert_eq!(entries[0].original, "resourcepacks/Nebula.zip");
    fs::remove_file(&pack).unwrap();
    q.restore(&entries[0].id, &s.instance).unwrap();
    assert_eq!(fs::read(&pack).unwrap(), PAGE_404);
    assert!(q.list().unwrap().is_empty());
}

#[tokio::test]
async fn pack_modified_by_player_is_never_replaced() {
    let s = setup("modifie").await;
    let pack = s.instance.join("resourcepacks/Nebula.zip");
    let modified = zip_with("{\"pack\":{\"description\":\"retouché par le joueur\"}}");
    fs::write(&pack, &modified).unwrap();

    let report = instance::sync(&s.ctx, &s.instance, &s.files, &ignored(), true).await.unwrap();
    assert_eq!(fs::read(&pack).unwrap(), modified, "pack du joueur intact");
    assert!(report.quarantined.is_empty());
    assert_eq!(report.ensure.downloaded, 0);
}

#[tokio::test]
async fn leftover_web_page_under_old_name_goes_to_quarantine_not_trash() {
    let s = setup("ancien-nom").await;
    let old = s.instance.join("resourcepacks/u00a71Blue u00a7f& u00a7dPink u00a7fNebula.zip");
    fs::write(&old, PAGE_404).unwrap();

    let report = instance::sync(&s.ctx, &s.instance, &s.files, &ignored(), true).await.unwrap();
    assert!(!old.exists());
    assert_eq!(report.quarantined.len(), 1);
    assert!(report.quarantined[0].original.contains("Nebula"));

    // Restauration refusée si un fichier occupe déjà la place.
    fs::write(&old, b"autre").unwrap();
    let q = Quarantine::new(s.root.join(".pl/quarantine"));
    assert!(q.restore(&report.quarantined[0].id, &s.instance).is_err());
    assert_eq!(fs::read(&old).unwrap(), b"autre", "rien n'est écrasé");
}

#[tokio::test]
async fn player_files_and_unknown_damage_are_left_alone() {
    let s = setup("prudence").await;
    let own_pack = s.instance.join("resourcepacks/MonPack.zip");
    let truncated = s.instance.join("resourcepacks/Tronque.zip");
    let options = s.instance.join("options.txt");
    let own = zip_with("{\"pack\":{\"description\":\"perso\"}}");
    fs::write(&own_pack, &own).unwrap();
    fs::write(&truncated, &own[..own.len() / 2]).unwrap();
    fs::write(&options, "fov:0.5").unwrap();

    let report = instance::sync(&s.ctx, &s.instance, &s.files, &ignored(), true).await.unwrap();
    assert_eq!(fs::read(&own_pack).unwrap(), own, "pack personnel intact");
    assert!(truncated.exists(), "archive abîmée mais pas une page web : laissée en place");
    assert_eq!(report.suspicious, vec!["resourcepacks/Tronque.zip".to_owned()]);
    assert_eq!(fs::read_to_string(&options).unwrap(), "fov:0.5");
    assert!(report.quarantined.is_empty());
}
