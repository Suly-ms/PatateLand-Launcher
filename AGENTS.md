# Guide pour les agents IA (et les humains pressés)

Launcher Minecraft du serveur **PatateLand**. Mono-repo. Tout le projet est
en **français** : code commenté, textes de l'interface, docs, messages de
commit. Garder cette langue.

## Carte du dépôt

| Dossier | Rôle | Toucher ? |
|---|---|---|
| `launcher/` | **Le launcher**, Rust + Tauri 2. C'est là que se fait le travail. | Oui |
| `web/` | Serveur de fichiers PHP (`/config`, `/articles`, instances). Routes dans `web/.htaccess`. | Si demandé |
| `.github/workflows/release.yml` | Compilation Windows/Mac/Linux → release GitHub **brouillon**. | Avec prudence |

### `launcher/` (workspace Cargo, version unique dans `launcher/Cargo.toml`)

| Crate | Contenu |
|---|---|
| `crates/pl-engine` | Bibliothèque sans interface : comptes (`auth/`), serveur PatateLand (`remote.rs`), installation Minecraft/Forge/Java (`vanilla.rs`, `forge.rs`, `java.rs`, `game.rs`), fichiers d'instance (`instance.rs`, `quarantine.rs`, `integrity.rs`), réglages (`settings.rs`), actualités (`news.rs`, nettoyage HTML), statut serveur (`status.rs`), `servers.dat` (`nbt.rs`, `servers_dat.rs`), mises à jour signées (`update.rs`). Tests d'intégration dans `tests/`. |
| `crates/pl-app` | Application Tauri. Commandes appelées par l'interface : `src/commands.rs` (principales), `extras.rs` (Java, démarrage auto, stockage, quarantaine, crash), `friends.rs`, `tray.rs`, `updater.rs`, `play.rs` (bouton JOUER), `window.rs` (fenêtres, menu de l'icône Linux). Interface : `ui/` en **HTML/CSS/JS sans bundler** (`ui/js/app.js`, `window.__TAURI__.core.invoke`). |
| `crates/pl-cli` | Même moteur en ligne de commande (`info`, `install`, `launch`, `account`, `settings`, `packs`, `storage`, `quarantine`, `release`). Idéal pour tester le moteur sans interface. |
| `crates/pl-setup` | Installateur Windows. **Ne compile que sous Windows.** |

L'ancien launcher Electron 1.x n'est plus dans ce dépôt : il est sur la
branche `electron`, pour consultation seulement (`git show origin/electron:src/…`,
ou `git worktree add launcher/run/electron electron`).

Docs de conception dans `launcher/docs/` (numérotées dans l'ordre du projet).
Les plus utiles : `08-parite-ancien-launcher.md` (liste des fonctions),
`02-decisions-securite-et-prototype.md` (règles de sécurité),
`11-publication.md` (releases).

## Compiler et tester

Toujours depuis `launcher/`. La toolchain Rust est locale au projet
(`.toolchain/`, ignoré par git) et le dossier de compilation est
`target-msvc/`, même sous Linux.

```bash
cd launcher
source env.sh                                   # Rust du projet
# Linux uniquement : dépendances système (voir tools/linux-deps.sh, marche sans sudo)
bash tools/linux-deps.sh && source .toolchain/sysroot-env.sh

cargo test --release --workspace --exclude pl-setup   # Linux/Mac
cargo test --release --workspace                      # Windows
cargo build --release                                 # puis les exécutables dans target-msvc/release/
```

- Toolchain absente : `curl https://sh.rustup.rs | RUSTUP_HOME=.toolchain/rustup CARGO_HOME=.toolchain/cargo sh -s -- -y --no-modify-path`.
- `cargo test -p pl-engine` ne reconstruit **pas** `pl-cli` ni l'application : refaire `cargo build --release` avant de les lancer.
- Formatage : le code est formaté à la main, il ne suit pas `rustfmt`. Ne pas lancer `cargo fmt` sur tout le workspace dans un commit de fonctionnalité : ça reformate des centaines de lignes. Garder le style des fichiers voisins (lignes jusqu'à ~120 caractères).

## Lancer sans toucher aux vraies données

Variables lues par l'application et par `pl-cli` (`--root`, `--data`, `--server`) :

| Variable | Effet |
|---|---|
| `PL_ROOT` | Dossier de jeu (instances, Java, bibliothèques). |
| `PL_DATA` | Dossier du launcher (comptes, réglages, logs). |
| `PL_SERVER` | Serveur de fichiers. Défaut : `https://filelauncher.patateland.fr`. |
| `PL_NO_UPDATE` | Désactive la recherche de mises à jour. |
| `PL_AUTOPLAY=1` | Lance le jeu au démarrage (une fois). |

```bash
node tools/mock-file-server.mjs run/mock-server/files 8787   # faux serveur (un dossier = une instance)
./run-app.sh                                                 # appli sur run/game et run/data
./target-msvc/release/pl-cli --server http://127.0.0.1:8787 --root run/game --data run/data \
    launch --instance <nom> --name Testeur --exit-when-ready   # vrai lancement, fermé au menu
```

`run/` est ignoré par git. Ne jamais pointer les tests vers les dossiers réels
du joueur ni vers ceux de l'ancien launcher.

## Règles à ne pas casser

Sécurité (détails : `launcher/docs/02-decisions-securite-et-prototype.md`) :
- **Interface** : tout texte venant du serveur ou du joueur s'affiche avec `textContent`. Seules les actualités passent par `innerHTML`, après nettoyage côté Rust (`pl-engine/src/news.rs`).
- **Liens et dossiers** : passer par les commandes existantes. `open_url` n'accepte que HTTPS et une liste de domaines (`commands.rs`), `open_instance_folder` une liste de dossiers, `crash_report_open`/`crash_report_read` des `.txt` dans un `crash-reports/` du dossier de jeu.
- **Secrets** : aucun dans le code ni la config embarquée (pas de webhook Discord, pas de clé). La clé de signature des mises à jour reste hors du dépôt (`run/update-signing-key.txt`, secret GitHub `UPDATE_SIGNING_KEY`).
- **Jeton AZauth** : il ne quitte jamais Rust et n'est envoyé qu'en HTTPS au site du compte.

Comportement :
- **Comptes** : jamais supprimés automatiquement, même si un service est en panne. Seule une action explicite du joueur supprime un compte.
- **Réglages** : toute valeur passe par `Settings::validate` (`pl-engine/src/settings.rs`). L'interface ne suffit pas, car un champ `<input max>` n'empêche pas la saisie. Un réglage invalide déjà enregistré doit rester chargeable.
- **Liste blanche** : une instance réservée (`whitelistActive`) n'apparaît que pour les joueurs autorisés, partout (accueil, menu de l'icône). Utiliser `state::allowed` / `state::playable_instances`. `play::start` revérifie de toute façon.
- **Fichiers d'instance** : un fichier modifiable par le joueur (`ignored`) qui est abîmé part en **quarantaine** (restaurable), il n'est jamais supprimé. `verify: true` supprime les fichiers en trop, sauf ceux listés dans `ignored`.
- **Ancien launcher** : le nouveau ne lit ni n'écrit ses fichiers (exception voulue : l'installateur Windows désinstalle l'ancien, `pl-setup/src/win.rs`).

Pièges connus :
- **Plusieurs parties en même temps**, possible via le menu de l'icône. Les événements `game`/`exited` ne portent pas le nom de l'instance, et `game-finished` oui. L'interface garde `state.running` : ne pas la remettre « au repos » tant qu'une partie tourne.
- **Fenêtre détruite pendant le jeu** (`close_behavior`, `window::release_main`). Au retour, l'état vient de `bootstrap` (`running`) et de `take_last_exit`, il ne reste rien en mémoire JS.
- **Menu de l'icône différent selon le système** : menu natif sous Linux (`window.rs`, `tray_menu`), fenêtre HTML sous Windows/Mac (`tray.rs` + `ui/tray.html`). Toute modification doit couvrir les deux.
- **Notifications** : implémentation Windows (WinRT, `notify.rs`) ou plugin Tauri ailleurs.
- **Démarrage automatique** : écrit dans le système (registre Windows, `~/.config/autostart` sous Linux). L'interface affiche l'état réel du système, pas le réglage.

## Vérifier une modification

1. `cargo test --release --workspace --exclude pl-setup`, avec un test unitaire à côté du code modifié pour toute règle métier.
2. Moteur : scénario `pl-cli` contre le faux serveur (voir plus haut).
3. Interface : tests de bout en bout dans `launcher/tools/e2e/` (vraie application pilotée par WebDriver, voir son README).
4. CI : un push sur `master` ou `all-features` qui touche `launcher/` compile les 4 plateformes et met à jour une release **brouillon**. Rien n'est publié aux joueurs sans clic sur « Publish release ».

## Publication

- Version : **un seul endroit**, `version = "…"` dans `launcher/Cargo.toml`.
- Notes de version : `launcher/NOUVEAUTES.txt`.
- Procédure complète : `launcher/docs/11-publication.md`. Une IA ne publie jamais de release et ne pousse jamais sans demande explicite.
