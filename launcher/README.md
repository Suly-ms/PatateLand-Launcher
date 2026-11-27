# PatateLand Launcher (Rust)

Le launcher PatateLand, écrit en Rust (Tauri). Il remplace l'ancien launcher
Electron (`../legacy/electron/`) : aucun fichier, compte, instance ou réglage
de l'ancien launcher n'est lu en écriture ni modifié.

Toutes les commandes ci-dessous se lancent depuis ce dossier (`launcher/`).

Documents :
- [docs/01-audit-et-architecture.md](docs/01-audit-et-architecture.md)
- [docs/02-decisions-securite-et-prototype.md](docs/02-decisions-securite-et-prototype.md)

## Compiler

La toolchain Rust est installée **dans ce dossier** (`.toolchain/`).

```bash
source env.sh
cargo build --release
cargo test --release
```

## Utiliser le prototype en ligne de commande

Tout est écrit dans `run/game` (dans ce projet) par défaut.

```bash
# Infos du serveur PatateLand (config + instances)
./target-msvc/release/pl-cli.exe info

# Installer / réparer une instance (lit l'instance sur le serveur PatateLand)
./target-msvc/release/pl-cli.exe install --instance Opti

# Sans serveur : versions données à la main
./target-msvc/release/pl-cli.exe install --instance Opti --mc 1.20.1 --forge 47.4.16

# Lancer avec un compte hors-ligne (ferme le jeu au menu principal)
./target-msvc/release/pl-cli.exe launch --instance Opti --mc 1.20.1 --forge 47.4.16 \
    --name PatateTest --exit-when-ready

# Comparer les méthodes de vérification des fichiers
./target-msvc/release/pl-cli.exe verify-bench --mc 1.20.1 --forge 47.4.16
```

Options utiles : `--full-verify` (revérifie tout, mode « Réparer »),
`--concurrency N` (téléchargements simultanés), `--root DOSSIER`,
`--report FICHIER.json` (mesures pour le protocole PatateBench).

## Comptes

Stockés dans `run/data` par défaut (`--data`). Tokens chiffrés par Windows
(DPAPI). Un compte n'est **jamais supprimé automatiquement**.

```bash
./target-msvc/release/pl-cli.exe account add-offline --name PatateTest
./target-msvc/release/pl-cli.exe account add-azauth --site https://patateland.fr --email moi@exemple.fr
./target-msvc/release/pl-cli.exe account add-microsoft
./target-msvc/release/pl-cli.exe account list
./target-msvc/release/pl-cli.exe account refresh
./target-msvc/release/pl-cli.exe launch --account PatateTest --instance Opti
```

## Réglages, packs, stockage

```bash
./target-msvc/release/pl-cli.exe settings show
./target-msvc/release/pl-cli.exe settings set memory '{"min_gb":2,"max_gb":6}'
./target-msvc/release/pl-cli.exe packs --instance Extra --kind shader
./target-msvc/release/pl-cli.exe storage --clear-logs Extra
./target-msvc/release/pl-cli.exe quarantine                 # archives invalides mises de côté
./target-msvc/release/pl-cli.exe quarantine --restore <id>  # remettre un fichier à sa place
```

Toujours `cargo build --release` (tout le projet) avant de tester avec
`pl-cli` : `cargo test -p pl-engine` ne reconstruit pas l'exécutable.

## Tester sans le serveur PatateLand

```bash
node tools/mock-file-server.mjs run/mock-server/files 8787
./target-msvc/release/pl-cli.exe --server http://127.0.0.1:8787 launch --instance Extra --account PatateTest
```

## Mode développement (Visual Studio Code)

```powershell
powershell -ExecutionPolicy Bypass -File .\dev.ps1                 # serveur Selvania
powershell -ExecutionPolicy Bypass -File .\dev.ps1 -Server mock    # faux serveur local
```

Rechargement automatique de l'interface, recompilation du Rust à chaque
modification. Arrêt : Ctrl+C.

## Application (Tauri)

```bash
source env.sh && cargo build --release            # compile tout, dont l'application
node tools/mock-file-server.mjs run/mock-server/files 8787
./run-app.sh                                      # lance l'application sur les données de test
```

Voir [docs/06-socle-tauri.md](docs/06-socle-tauri.md) et
[docs/07-microsoft-hors-connexion-installateur.md](docs/07-microsoft-hors-connexion-installateur.md).

Autres serveurs de test :

```bash
# Serveur de démonstration du Selvania Launcher (vrai serveur distant)
PL_SERVER=http://luuxcraft.fr/api/user/bb8f5247-1d38-41bb-ab6d-3200471a06b2 ./run-app.sh
```

Le launcher garde une copie des informations du serveur : si celui-ci est
injoignable, les instances déjà installées restent jouables.

### Installateur

```powershell
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
# -> target-msvc\release\bundle\nsis\PatateLand Rust_<version>_x64-setup.exe
```

Nom de produit « PatateLand Rust » : raccourcis, dossier d'installation et
désinstallation distincts de l'ancien launcher « PatateLand ».

## Mesures comparatives

Voir [bench/README.md](bench/README.md) (protocole PatateBench).

## Organisation

| Dossier | Rôle |
|---|---|
| `crates/pl-engine` | Moteur : téléchargements, vérification, Java, Minecraft, Forge, instance, lancement |
| `crates/pl-cli` | Outil de test du moteur |
| `docs/` | Audit, architecture, décisions |
| `run/` | Données de test (ignoré par git) |
| `.toolchain/` | Rust + `as`/`dlltool` locaux (ignoré par git) |
