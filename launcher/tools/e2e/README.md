# Tests de bout en bout (Linux)

La **vraie application** est pilotée par WebDriver (`tauri-driver` +
`WebKitWebDriver`), contre un faux serveur PatateLand. Rien n'est simulé
côté Rust : installation, lancement de Minecraft, crash, `servers.dat`,
icône, notifications.

Tout est écrit dans `launcher/run/e2e/` (ignoré par git). Les vrais
dossiers du joueur ne sont jamais touchés, à une exception près : le test du
démarrage automatique crée puis retire `~/.config/autostart/PatateLand.desktop`.

## Prérequis

```bash
cd launcher
source env.sh
bash tools/linux-deps.sh --e2e        # dépendances + WebKitWebDriver + tauri-driver (sans sudo)
source .toolchain/sysroot-env.sh
cargo build --release -p pl-app -p pl-cli
```

Il faut aussi Node.js 18 ou plus, une session graphique (les fenêtres
s'ouvrent à l'écran, Minecraft compris) et, pour le test de l'icône, un
bureau qui affiche les icônes AppIndicator (GNOME : extension AppIndicator).

## Lancer

```bash
bash tools/e2e/run.sh             # toutes les phases
bash tools/e2e/run.sh p1 p3       # phases au choix
```

| Phase | Contenu | Durée |
|---|---|---|
| `p1` | Démarrage, connexion hors-ligne, accueil (actualités, statut, instances, liens, bandeau d'avis), tous les paramètres, packs, stockage | ~3 min |
| `p2` | JOUER : réparation et nettoyage de l'instance, carte de lancement, console, `servers.dat`, deux instances en même temps, crash avec rapport, relance | ~5 min (+ ~3 min au premier téléchargement de Minecraft) |
| `p3` | Maintenance (bloquante, liste blanche, fin automatique), serveur injoignable, modes de connexion Microsoft/AZauth, fenêtre, icône et son menu, instance unique, Ctrl+W | ~3 min |
| `p4` | Moteur par `pl-cli` : quarantaine et restauration, réparation des fichiers partagés, packs, réglages, comptes, stockage | ~1 min |

Résultat : une ligne `OK` ou `FAIL` par vérification, un résumé par phase
(`run/e2e/p1.json`…), et des captures dans `run/e2e/shots/`.

`p1` doit tourner avant `p2` et `p3`, qui réutilisent son compte. `run.sh`
repart de données vides (comptes, réglages) à chaque exécution, mais garde le
dossier de jeu (`run/e2e/game`) pour ne pas retélécharger Minecraft.

## Fichiers

| Fichier | Rôle |
|---|---|
| `run.sh` | Démarre faux serveur, capture des notifications (D-Bus) et `tauri-driver`, puis les phases. |
| `mock.mjs` | Faux serveur HTTP (`/config`, `/files`, `/articles`, manifests) et faux serveur Minecraft (statut). Son état (`run/e2e/state.json`) est modifié par les tests en cours de route. |
| `state.base.json` | État de départ : instances `Test`, `Opti`, `Secret` (réservée à un autre joueur), actualités dont une piégée. |
| `wd.mjs` | Mini client WebDriver et outils (`check`, `step`, `setState`). |
| `p1-ui.mjs`, `p2-play.mjs`, `p3-misc.mjs`, `p4-engine.sh` | Les phases. |

Les ouvertures de liens et de dossiers passent par un faux `xdg-open` qui les
note dans `run/e2e/opened.log` : aucun navigateur ne s'ouvre.

## Limites

- Connexions Microsoft et AZauth réelles, système d'amis : comptes réels
  nécessaires. Seuls l'affichage et les erreurs sont testés ici. Les échanges
  avec un site simulé sont couverts par `crates/pl-engine/tests/`.
- Boîtes de dialogue natives (choix de Java, import de pack) : non pilotables.
  Le contenu des dossiers est testé directement.
- **Point ouvert (27/11/2026).** Il arrive (2 exécutions de `p2` sur 4) que
  WebKitWebDriver supprime la session (« page crash or hang ») au moment où
  un Minecraft démarre et sature le processeur. Le pilote ferme alors
  l'application et le jeu. Pas de manque de mémoire constaté. On ne sait pas
  encore si la page WebKit plante vraiment (un joueur verrait une fenêtre
  blanche) ou si le pilote est seulement trop impatient. Un `FAIL` en `p2` avec
  ce message se relance avant d'être analysé.
- Windows et Mac : ces tests sont pour Linux. Le même code Rust tourne
  partout, mais le menu de l'icône, les notifications et le démarrage
  automatique ont une implémentation par système.
