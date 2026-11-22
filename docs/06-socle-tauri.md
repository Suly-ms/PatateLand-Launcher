# Socle Tauri 2 : premier résultat visuel (étape 4, début)

## 1. Ce qui a été fait

### Compilation

- **MSVC est l'outil par défaut** du projet. GNU reste intact et sert de
  secours (procédure dans [05](05-outils-de-compilation-tauri.md)) : 41/41
  tests vérifiés dans les deux variantes au moment de la bascule.
- La bibliothèque C de Microsoft est intégrée aux exe : les joueurs n'ont
  rien à installer en plus.

### Architecture

```
crates/
├─ pl-engine/   moteur (inchangé dans son rôle) + nouveaux modules :
│               game.rs (parcours JOUER commun), status.rs (statut serveur),
│               news.rs (actualités nettoyées)
├─ pl-cli/      outil de test : utilise maintenant game.rs, comme l'interface
└─ pl-app/      application Tauri : simple passerelle interface ↔ moteur
   ├─ src/      state.rs (état, vues), commands.rs (20 commandes), main.rs
   ├─ ui/       HTML / CSS / JS sans framework ni outil de build
   └─ capabilities/default.json   permissions de l'interface
```

Le parcours JOUER a été **sorti de l'outil en ligne de commande vers le
moteur** (`game.rs`). L'outil et l'interface exécutent maintenant exactement
le même code. Non-régression vérifiée après le déplacement : Opti au menu
en 16 s, Extra (298 mods) au menu en 75 s, arrêt anormal détecté.

### Sécurité de l'interface

| Mesure | Détail |
|---|---|
| Permissions minimales | L'interface peut seulement écouter les événements du launcher et déplacer la fenêtre. Pas d'accès au disque, au réseau ni au shell |
| Commandes vérifiées | L'interface envoie des noms ou des identifiants, jamais de chemin. L'import de packs ouvre la boîte de dialogue côté Rust |
| CSP stricte | `script-src 'self'` : aucun script inline ni distant, aucun `eval` |
| Actualités | Nettoyées en Rust (balises de mise en forme uniquement, liens `https` seulement, adresses relatives supprimées). Le reste du texte est affiché en `textContent` |
| Liens | Ouverts dans le navigateur, uniquement en `https` et vers des domaines connus. Un lien ne peut jamais faire naviguer la fenêtre |
| Une seule instance | Relancer le launcher remet la fenêtre existante au premier plan |

**Vérifié dans la vraie fenêtre** : une actualité piégée du faux serveur
(`<script>`, `onerror`, lien `javascript:`) s'affiche sans aucun effet.

### Identité visuelle

Reprise de l'ancien launcher :
- même accent orange (`#fd8e39` → `#f27312`), police Poppins, verre fumé ;
- même disposition : pastille de statut, actualités, barre du bas avec la
  tête du joueur, JOUER, l'instance, les réseaux sociaux et les réglages ;
- mêmes fonds d'écran, convertis en JPEG : **48,2 Mo → 3,5 Mo**, sans
  différence visible.

### Fonctionnalités de ce premier socle

| Fonction | État |
|---|---|
| Fenêtre sans bordure, réduire / agrandir / fermer, déplacement | ✅ |
| Statut du serveur (en ligne, ping, joueurs), rafraîchi toutes les 30 s seulement si la fenêtre est visible | ✅ (protocole testé ; « Fermé » affiché car le vrai serveur est coupé) |
| Actualités (RSS ou `/articles`), carrousel avec **un seul** minuteur, en pause quand la fenêtre est cachée | ✅ |
| Comptes : liste, sélection, suppression explicite, ajout hors-ligne, connexion AZauth + A2F, vérification en arrière-plan sans écran bloquant | ✅ (AZauth réel à tester quand le site reviendra) |
| Choix de l'instance, avec liste blanche et descriptions | ✅ |
| JOUER : installation, progression (Mo, étapes), lancement, fenêtre réduite pendant le jeu puis rétablie | ✅ branché sur le moteur testé |
| Crash : fenêtre d'information + accès aux rapports | ✅ |
| Réglages : RAM (recommandation, limites), résolution, plein écran, comportement pendant le jeu, thème, **mode léger**, téléchargements simultanés, rapports de crash | ✅ |
| Resource packs et shaders : liste, ajout, suppression, ouvrir le dossier | ✅ |
| Connexion Microsoft dans l'interface | ⏳ prochaine étape |
| Icône dans la zone de notification | ⏳ prochaine étape |

## 2. Premiers chiffres

| Mesure | Valeur |
|---|---|
| Exe de l'application (interface, polices, fonds compris) | 20,1 Mo |
| Interface (HTML + CSS + JS) | 1 135 lignes, 3,8 Mo d'images et polices |
| Passerelle Rust de l'application | 693 lignes |
| **RAM fenêtre ouverte, avec le flou** | **≈ 230 Mo privés** (7 processus) : application Rust 8 Mo, WebView2 ≈ 220 Mo, dont 129 Mo pour le processus graphique |

Lecture honnête : WebView2 n'est pas gratuit. L'essentiel de la RAM vient
de lui, et en particulier de l'effet de flou. Deux leviers sont prévus :

1. **Mode léger** (déjà disponible) : retire le flou et les animations. Son
   gain est à mesurer.
2. **Supprimer la fenêtre pendant le jeu** (prochaine étape) : seul le
   moteur Rust reste actif. On vise **environ 10 à 30 Mo pendant que
   Minecraft tourne**, au lieu de garder tout le navigateur en mémoire comme
   l'ancien launcher.

La comparaison avec l'ancien launcher se fera avec le protocole PatateBench,
quand le serveur reviendra.

## 2 bis. Suite (21/11/2026) : serveur Selvania réel, fenêtre libérée en jeu, mode léger

### Test sur un vrai serveur : celui du Selvania Launcher

Le serveur PatateLand étant coupé, le serveur de démonstration du Selvania
Launcher (le modèle d'origine du launcher PatateLand) sert de vrai serveur
distant :
`http://luuxcraft.fr/api/user/bb8f5247-1d38-41bb-ab6d-3200471a06b2`.

| Point testé | Résultat |
|---|---|
| Liste des instances | Ce serveur utilise `/instances` (format Selvania récent) et non `/files`. **Le moteur lit maintenant les deux** : `/files` d'abord, puis `/instances` |
| Instance « Hypixel » : **Minecraft 26.3** vanilla (version très récente, autre Java : `java-runtime-epsilon`) | ✅ 581 Mo installés en 17 s, menu principal en 10,7 s, 30 Mo de RAM au maximum pour le moteur |
| Statut du serveur `play.hypixel.net` | ✅ « En ligne · 307 ms », **18 124 joueurs** |
| Actualités réelles (`/articles`, HTML) | ✅ affichées proprement après nettoyage |
| Mode de connexion annoncé par le serveur | `online: true` → Microsoft (écran prévu à la prochaine étape) |

### Fenêtre fermée pendant le jeu + icône de notification

- Au lancement de Minecraft, **la fenêtre est détruite**, pas seulement
  cachée. WebView2 rend sa mémoire et seul le moteur Rust reste actif.
- Une **icône PatateLand** dans la zone de notification permet de rouvrir le
  launcher (« Ouvrir PatateLand », « Quitter »).
- À la fin de la partie, la fenêtre est recréée. Un crash survenu fenêtre
  fermée est gardé en mémoire et affiché à la réouverture.
- Rouvrir la fenêtre en pleine partie affiche « En jeu ».
- Réglage « Laisser le launcher ouvert » toujours disponible.
- `PL_AUTOPLAY=1` (tests et mesures uniquement) lance la partie dès
  l'ouverture.

### Mesures de la fenêtre ouverte (serveur Selvania, même PC)

| Configuration | RAM privée totale | CPU au repos (15 s) |
|---|---|---|
| Normal (flou, rendu par la carte graphique) | 227 Mo | **0,00 %** |
| Sans flou, rendu par la carte graphique | 266 Mo | 0,00 % |
| **Sans flou + sans processus graphique (`--disable-gpu`)** | **117 Mo** | 0,00 % |

Détail : sur les 266 Mo, la partie Rust pèse 11 Mo et le **processus
graphique de WebView2 162 Mo**, flou ou pas. Retirer le flou seul ne change
donc rien ; retirer le processus graphique fait gagner environ 150 Mo.
**Le mode léger fait désormais les deux.** La partie sans GPU s'applique à
la création de la fenêtre, donc au prochain démarrage.

Le CPU au repos est à 0 % : un seul minuteur pour les actualités et un pour
le statut, tous deux à l'arrêt quand la fenêtre est cachée (l'ancien
launcher en accumulait).

### À faire quand tu n'utilises pas ton PC

Les tests qui ouvrent une fenêtre (captures d'écran, Minecraft) ont été
**arrêtés dès que j'ai vu que tu jouais**. Ils mettaient la fenêtre du
launcher au premier plan. Restent à faire, avec ton accord et à un moment
où ça ne te gêne pas :

1. vérifier visuellement le mode léger sans processus graphique ;
2. mesurer la RAM pendant une partie, fenêtre fermée (objectif : 10 à 30 Mo).

## 3. Essayer

```bash
node tools/mock-file-server.mjs run/mock-server/files 8787   # faux serveur
./run-app.sh                                                  # données de test du projet
```

`run-app.sh` utilise `run/game` et `run/data`. Sans ces variables,
l'application range ses données dans `%APPDATA%\.patateland-rust` et
`%APPDATA%\PatateLand-Rust` : **jamais dans les dossiers de l'ancien
launcher**.

## 4. Prochaines étapes proposées

1. Fermer la fenêtre (WebView2) pendant le jeu et la recréer à la fin ;
   icône dans la zone de notification. Mesure de la RAM en jeu.
2. Mesure du mode léger.
3. Connexion Microsoft dans l'interface.
4. Conserver la liste des instances quand le serveur est injoignable, pour
   pouvoir jouer à une instance déjà installée.
5. Installateur (NSIS) et mise à jour signée.
6. Suppression des outils GNU, une fois tout cela validé et avec ton accord.
