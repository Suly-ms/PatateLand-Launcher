# PatateLand

Mono-repo du launcher Minecraft PatateLand.

| Dossier | Contenu |
|---|---|
| [`launcher/`](launcher/) | **Le launcher**, en Rust (Tauri) : moteur `pl-engine`, application `pl-app`, outil en ligne de commande `pl-cli`, installateur `pl-setup`. |
| [`web/`](web/) | Serveur de fichiers en PHP : liste des instances, configuration et actualités lues par le launcher. |
| [`legacy/electron/`](legacy/electron/) | Ancien launcher Electron (versions 1.x). Il n'est plus compilé ni publié et sert seulement de référence. |

## Compiler le launcher

```bash
cd launcher
source env.sh                      # toolchain Rust locale (launcher/.toolchain)
bash tools/linux-deps.sh           # Linux : dépendances système, sans sudo
source .toolchain/sysroot-env.sh   # Linux
cargo build --release
cargo test --release --workspace --exclude pl-setup   # pl-setup = installateur Windows
bash tools/e2e/run.sh              # Linux : tests de bout en bout de la vraie appli
```

Détails : [launcher/README.md](launcher/README.md), tests de bout en bout :
[launcher/tools/e2e/README.md](launcher/tools/e2e/README.md).

## Agents IA

Conventions, architecture, règles de sécurité et pièges connus :
[AGENTS.md](AGENTS.md) (lu automatiquement par Claude Code via `CLAUDE.md`).

## Publication

La compilation automatique ([.github/workflows/release.yml](.github/workflows/release.yml))
se lance à chaque push sur `master` ou `all-features` qui modifie `launcher/`.
Elle crée une release GitHub en **brouillon** : rien n'arrive aux joueurs tant
que la release n'est pas publiée à la main.
Voir [launcher/docs/11-publication.md](launcher/docs/11-publication.md).

## Branches

- `master` : branche principale (mono-repo).
- `electron` : l'ancien launcher Electron tel qu'il était publié, pour pouvoir
  republier une version 1.x en cas de besoin.
