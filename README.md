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
source env.sh          # toolchain Rust locale, si elle est installée dans launcher/.toolchain
cargo build --release
cargo test --release
```

Détails : [launcher/README.md](launcher/README.md).

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
