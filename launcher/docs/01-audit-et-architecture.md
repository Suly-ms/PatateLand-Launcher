# PatateLand Launcher en Rust : audit et proposition d'architecture

> Étape 1 et 2 du plan (audit + architecture). Rien n'a été modifié dans
> `PatateLand-Launcher/`. Ce dossier ne contient pour l'instant que ce
> document. Aucun code ne sera écrit avant validation de la stratégie.

---

## 1. Audit du launcher actuel

### 1.1 Architecture et technologies

| Élément | Actuel |
|---|---|
| Base | Electron 40 (Chromium + Node.js embarqués), fork du template Selvania/Luuxis |
| Code | ~6 000 lignes de JS : `app.js` (process principal), 3 panels (`home`, `settings`, `login`), flyout `friends`, fenêtres splash / logs / tray |
| Moteur Minecraft | `minecraft-java-core` 4.2.5, **patché** (patch-package) : copie de fichiers Windows, code de sortie du jeu, chemin log4j |
| Stockage | `electron-store` (fichier `launcher-data.json` chiffré AES-256-CBC, clé dans `key.txt`) |
| Mise à jour | `electron-updater` sur les releases GitHub (Windows), lien manuel (Mac/Linux) |
| Build | `javascript-obfuscator` + `electron-builder` (NSIS), CI GitHub Actions sur push `master` |
| Dépendances | 8 directes en prod, 77 au total en prod, `node_modules` = **1,0 Go** en dev |

Toutes les fenêtres tournent avec `nodeIntegration: true` et
`contextIsolation: false` : l'interface a un accès complet au disque et au
système.

### 1.2 Mesures statiques (build actuel 1.4.2, Windows x64)

| Mesure | Valeur |
|---|---|
| Installateur x64 | **146 Mo** |
| Installateur universel (x64 + arm64) | 292 Mo |
| Dossier installé (`win-unpacked`) | **398 Mo** |
| dont `app.asar` (code + dépendances) | 64 Mo |
| Processus au repos | au minimum 4 (principal, GPU, utilitaire réseau, 1 renderer par fenêtre) |

Les mesures dynamiques (RAM, CPU, temps de démarrage) n'ont **pas** été
faites : lancer le launcher actuel rafraîchit les comptes et peut déclencher
la mise à jour automatique, ce qui toucherait à ton environnement. Le
protocole de mesure est en section 5 et attend ton feu vert.

### 1.3 Ce qui ralentit le launcher (constaté dans le code)

Classé par impact estimé sur un PC modeste.

1. **Vérification de tous les fichiers à chaque lancement, un par un.**
   `checkBundle()` dans `minecraft-java-core` calcule le SHA-1 de *chaque*
   fichier présent (assets, libraries, mods, configs…) à chaque clic sur
   JOUER, dans une boucle `for … await` : **un seul fichier à la fois**.
   L'instance Extra compte 248 mods, et les assets font 1,3 Go à eux seuls.
   Sur un disque dur ou un CPU modeste, c'est le principal temps d'attente
   avant que le jeu démarre.
2. **Accumulation de minuteurs dans les news (fuite).** `news()` est relancé
   toutes les 3 min et crée à chaque fois un nouveau `setInterval` de 12 s
   sans arrêter l'ancien. Après 1 h, ~20 minuteurs redessinent les news en
   parallèle ; après une soirée, plus d'une centaine. Le CPU au repos
   augmente donc avec le temps d'ouverture du launcher.
3. **Le throttling Chromium est désactivé** (`backgroundThrottling: false`)
   pour que le chat fonctionne launcher caché. Conséquence : tous les
   minuteurs tournent à pleine vitesse même pendant que le joueur est en jeu.
4. **Beaucoup de sondages réseau en continu**, launcher ouvert ou dans le tray :
   - statut serveur + liste complète des instances : toutes les 15 s
   - news : toutes les 3 min
   - compteurs de messages non lus : toutes les 30 s
   - présence (heartbeat) : toutes les 60 s
   - rafraîchissement du token AZauth : toutes les 20 min
   - chaque fenêtre de chat ouverte : toutes les 6 s
5. **Démarrage séquentiel.** Le splash attend 2,1 s d'animation fixe *avant*
   de chercher les mises à jour, puis : vérif MAJ → téléchargement config →
   création de la fenêtre principale → re-téléchargement de la config →
   rafraîchissement des comptes **un par un** → liste des instances
   téléchargée plusieurs fois (home, login, settings).
6. **Taille embarquée.** Chromium + Node complets sont livrés avec
   l'application (~400 Mo installés) alors que l'interface est une page web
   simple.
7. **Le Chromium du launcher reste en mémoire pendant le jeu**, alors que
   Minecraft moddé a besoin de toute la RAM disponible sur une petite config.

### 1.4 Bugs trouvés pendant l'audit (non corrigés, launcher non touché)

| # | Problème | Effet |
|---|---|---|
| B1 | Fuite des minuteurs de news (voir 1.3.2) | CPU qui grimpe avec le temps |
| B2 | `app.js` et `trayMenu.js` lisent `new Store({ name: 'configClient' })`, un fichier qui n'existe pas (les données sont dans `launcher-data.json`, chiffré) | **« Démarrer minimisé » ne fonctionne jamais**, le thème du menu tray est toujours sombre, la restauration de l'auto-launch au démarrage ne lit rien |
| B3 | `download_multi` est enregistré en texte (`"5"`) et non en nombre | Fragile, dépend de conversions implicites |
| B4 | `checkMaintenanceBanner()` (home.js) n'est jamais appelée | Bandeau de maintenance in-launcher inactif |
| B5 | Le webhook Discord des crash reports est embarqué dans le client | Toute personne peut l'extraire de l'installateur et spammer le salon |
| B6 | HTML externe injecté sans échappement (news, pseudos/avatars dans la liste d'amis) avec `nodeIntegration: true` | Un contenu malveillant côté serveur pourrait exécuter du code sur les PC des joueurs |
| B7 | Patch de debug laissé dans `minecraft-java-core` (`[LAUNCH-DEBUG]`) | Bruit dans les logs |

Info du moment : `https://filelauncher.patateland.fr/config` et `/files`
répondaient **503** lors de l'audit. À surveiller, c'est aussi ce dont le
nouveau launcher aura besoin pour être testé.

### 1.5 Inventaire des fonctionnalités à reprendre

**Démarrage**
- Splash : fond et citation aléatoires, recherche de mise à jour, progression
- Mise à jour auto (Windows) / lien de téléchargement (Mac, Linux)
- Mode maintenance : message, compte à rebours, whitelist par pseudo
- Erreur « pas de connexion » propre
- Instance unique (deuxième lancement = remet la fenêtre au premier plan)

**Comptes**
- Connexion AZauth (site PatateLand) + double authentification (A2F)
- Connexion hors-ligne (pseudo) et Microsoft (selon `config.online`)
- Multi-comptes, compte actif, suppression, déconnexion depuis le tray
- Rafraîchissement des tokens au démarrage et toutes les 20 min
- Tête du skin du joueur

**Accueil**
- News : RSS ou JSON, carrousel auto (12 s), flèches, points, refresh
- Liens réseaux sociaux, bandeau « laisser un avis » (masquable par compte),
  bandeau partenaire MineStrator
- Sélecteur d'instance : whitelist par instance, descriptions, badge
  « En cours », Event toujours en dernier
- Statut serveur : en ligne/fermé, ping, joueurs connectés
- JOUER : plusieurs instances en parallèle, progression dans la barre des
  tâches, notifications « lancement » / « a démarré » / « erreur »
- Injection du serveur dans `servers.dat` (liste multijoueur) par instance
- Comportement du launcher pendant le jeu : rester ouvert / tray / caché
- Console de jeu (une fenêtre par instance), statut en cours/fermé/crash
- Détection de crash, affichage du rapport, envoi Discord opt-in avec infos
  système (OS, CPU, RAM, GPU)

**Paramètres**
- RAM min/max avec recommandation selon la machine et alerte petite config
- Résolution, plein écran, afficher la console
- Java personnalisé ou Java fourni
- Téléchargements simultanés
- Thème auto/sombre/clair
- Lancement au démarrage de Windows + démarrer minimisé
- Rapports de crash, notifications sociales (demandes, messages)
- Resource packs et shaders : ajout, liste, suppression, ouvrir le dossier
- Stockage : répartition par catégorie, vider logs / cache

**Amis (flyout)**
- Liste d'amis + présence en ligne, compteur dans la barre de titre
- Recherche, ajout, demandes reçues/envoyées, accepter/refuser/retirer
- Plusieurs fenêtres de chat déplaçables / agrandissables / réductibles
- Sélecteur d'émojis, conversion des émoticônes texte
- Badges de non-lus, notifications quand la fenêtre est cachée
- Profil avec rendu 3D du skin

**Tray**
- Menu custom : instances (avec état « en cours »), lancer une instance,
  paramètres, déconnexion, quitter

**Exclu volontairement** : prototype cosmétiques (`test_cosmetics-mod`),
comme demandé précédemment.

### 1.6 Données à préserver pour la compatibilité

| Donnée | Emplacement (Windows) | Format |
|---|---|---|
| Comptes + réglages | `%APPDATA%\PatateLand\launcher-data.json` | JSON chiffré AES-256-CBC. Fichier = `IV (16 o) + ":" + données`. Clé = PBKDF2-SHA512(contenu de `key.txt`, sel = IV lu comme texte UTF-8, 10 000 itérations, 32 o). Reproductible en Rust. |
| Clé | `%APPDATA%\PatateLand\key.txt` | texte hex |
| Jeu | `%APPDATA%\.patateland\` | `assets/`, `libraries/`, `versions/1.20.1`, `loader/forge`, `runtime/jre-17…`, `instances/{Opti,Extra,Event}` |

Le nouveau launcher pourra **importer en lecture seule** ces données
(comptes, réglages, et éventuellement copier les assets pour éviter de
retélécharger 1,3 Go), sans jamais écrire dans les dossiers de l'ancien.

---

## 2. Choix de l'interface : la décision structurante

L'interface actuelle est riche (fonds d'écran, animations, carrousel de
news en HTML, chat multi-fenêtres, émojis couleur, rendu de skins). Trois
options réalistes :

| | **A. Tauri 2** (recommandé) | B. Natif Slint | C. Natif egui / iced |
|---|---|---|---|
| Principe | Moteur 100 % Rust + interface HTML/CSS affichée par le WebView2 déjà présent dans Windows 10/11 | Interface déclarative native, rendu GPU/CPU | Interface immédiate native |
| Installateur estimé | ~5-10 Mo | ~5-10 Mo | ~5-10 Mo |
| RAM fenêtre ouverte (estimation à mesurer) | ~80-150 Mo | ~30-60 Mo | ~40-80 Mo |
| RAM dans le tray / pendant le jeu | **~10-20 Mo** (on détruit la WebView, seul le moteur Rust reste) | ~10-20 Mo | ~10-20 Mo |
| Reprise du design actuel | Directe (HTML/CSS réutilisés et nettoyés) | Tout à redessiner | Tout à redessiner, rendu moins soigné |
| News en HTML (RSS) | Natif | Difficile (pas de moteur HTML) | Difficile |
| Émojis couleur, chat | Natif | Partiel | Partiel |
| Effort / risque | Moyen | Élevé | Élevé |

**Recommandation : Tauri 2**, avec deux règles :

1. **Toute la logique en Rust** (téléchargements, vérification, Java,
   Forge, lancement, sondages réseau, tray, notifications). L'interface ne
   fait qu'afficher et envoyer des commandes. Elle n'a aucun accès direct
   au disque, ce qui corrige aussi B6.
2. **Pas de navigateur pendant le jeu** : quand le launcher passe dans le
   tray, la fenêtre est détruite (pas juste cachée). Seul le moteur Rust
   reste (~10-20 Mo, quasi 0 % CPU), avec le chat qui continue de notifier.
   C'est le gain le plus utile pour les PC modestes : la RAM revient à
   Minecraft.

Le moteur sera une bibliothèque indépendante de l'interface : si un jour on
veut une interface 100 % native, on ne réécrit que la couche graphique.

---

## 3. Architecture Rust proposée

### 3.1 Organisation (workspace Cargo)

```
PatateLand-Launcher-Rust/
├─ Cargo.toml                 workspace
├─ crates/
│  ├─ pl-core/        chemins, config utilisateur, erreurs, bus d'événements
│  ├─ pl-net/         client HTTP unique, gestionnaire de téléchargements
│  ├─ pl-integrity/   index de vérification (cache SHA-1), nettoyage d'instance
│  ├─ pl-minecraft/   manifest de version, assets, libraries, natives,
│  │                  arguments JVM/jeu, lancement et logs, servers.dat (NBT)
│  ├─ pl-forge/       installation Forge 1.20.1 (install_profile + processors)
│  ├─ pl-java/        runtime Java Mojang (jre-17), détection Java perso
│  ├─ pl-auth/        AZauth (+A2F), hors-ligne, Microsoft
│  ├─ pl-server/      config distante, instances, news (RSS/JSON),
│  │                  ping serveur Minecraft (protocole SLP), maintenance
│  ├─ pl-social/      API amis, chat, présence
│  ├─ pl-update/      mise à jour du launcher
│  └─ pl-migrate/     import en lecture seule depuis l'ancien launcher
├─ app/               shell Tauri : commandes, fenêtres, tray, notifications
├─ ui/                interface (HTML/CSS existants nettoyés + JS léger,
│                     sans framework lourd)
├─ bench/             scripts de mesure ancien vs nouveau
└─ docs/
```

### 3.2 Bibliothèques retenues

| Besoin | Choix | Pourquoi |
|---|---|---|
| Async | `tokio` | Standard, gère I/O réseau et disque en parallèle |
| HTTP | `reqwest` + `rustls` | Pas de dépendance OpenSSL, reprise (Range), compression |
| JSON | `serde`, `serde_json` | |
| Hash | `sha1` (RustCrypto, accéléré SHA-NI) | Vérification rapide |
| Zip / natives / Forge | `zip` | |
| RSS | `quick-xml` | Remplace `xml-js` |
| Chiffrement (import) | `aes`, `cbc`, `pbkdf2`, `sha2` | Lire l'ancien `launcher-data.json` |
| Stockage des secrets | `keyring` (Gestionnaire d'identification Windows) | Tokens mieux protégés que `key.txt` posé à côté |
| Logs | `tracing` + fichier tournant | |
| Erreurs | `thiserror` (crates), `anyhow` (app) | |
| Interface | `tauri` 2 + plugins `single-instance`, `autostart`, `notification`, `updater`, `dialog`, `opener` | Remplacent les fonctions Electron équivalentes |

Pas de `minecraft-java-core` équivalent : le lancement Minecraft/Forge est
réimplémenté proprement, sur les mêmes formats que le serveur de fichiers
actuel (`/config`, `/files`, manifest par instance), donc **aucun
changement côté serveur**.

### 3.3 Optimisations prévues (et ce qu'elles corrigent)

| Optimisation | Corrige |
|---|---|
| **Index de vérification** : on mémorise `chemin → (taille, date de modif, SHA-1)`. Au lancement, seuls les fichiers dont la taille ou la date a changé sont re-hashés. Re-hash complet disponible via un bouton « Réparer l'instance ». | 1.3.1 : passer de plusieurs dizaines de secondes à < 1 s quand rien n'a changé (à mesurer) |
| Hash et téléchargements **en parallèle** (limite réglable, comme aujourd'hui) | 1.3.1 |
| Téléchargement dans un fichier `.part`, vérif SHA-1 **pendant** le téléchargement, renommage atomique, **reprise** après coupure, 3 essais avec délai croissant | Fichiers corrompus après interruption |
| Cache HTTP (ETag / If-Modified-Since) pour config, instances, news | Requêtes inutiles toutes les 15 s |
| Démarrage parallèle : MAJ, config, comptes, instances, news lancés en même temps ; fenêtre affichée tout de suite avec un état « chargement » | 1.3.5 |
| Sondages regroupés et **mis en pause** quand ce n'est pas utile (statut serveur seulement fenêtre visible, chat seulement si conversation ouverte), WebSocket si l'API amis le permet un jour | 1.3.2 à 1.3.4 |
| WebView détruite en jeu / dans le tray | 1.3.7 |
| Un seul processus enfant à la fois par instance, tout s'arrête proprement à la fermeture (aucun processus fantôme) | « Aucun processus inutile » |

---

## 4. Méthode et isolation

### 4.1 Règles d'isolation (pendant toute l'expérimentation)

- Nouveau projet dans `Desktop\PatateLand-Launcher-Rust`, propre dépôt git,
  propres dépendances, propre build.
- Identifiant d'application différent : `fr.patateland.launcher.rust`
  (s'installe à côté de l'ancien, pas à sa place).
- Dossier de données différent : `%APPDATA%\PatateLand-Rust\` et dossier de
  jeu `%APPDATA%\.patateland-rust\`.
- Import depuis l'ancien launcher = **lecture seule** + copie, jamais de
  déplacement ni d'écriture dans `%APPDATA%\PatateLand` ou `.patateland`.
- Pas de publication sur le dépôt GitHub du launcher actuel, pas de mise à
  jour automatique vers les joueurs.

Retour arrière : il suffit de désinstaller la version Rust. L'ancien
launcher et toutes ses données ne sont jamais touchés.

### 4.2 Étapes, avec un point de validation à chaque fois

| Étape | Contenu | Livrable / critère de passage |
|---|---|---|
| **0** | Audit + architecture (ce document) | Ta validation |
| **1. Preuve de faisabilité** | Moteur en ligne de commande : télécharge l'instance Opti dans le dossier isolé, installe Forge 1.20.1, lance le jeu avec un compte hors-ligne | Le jeu se lance et rejoint le serveur. C'est la partie la plus risquée (installation Forge), on la valide en premier. |
| **2. Mesures** | Premier tableau comparatif sur la vérification et le lancement | Gain chiffré réel, sinon on s'arrête là |
| **3. Moteur complet** | Auth AZauth + A2F, Java, mises à jour, réglages, servers.dat, crash reports, import des anciennes données | Tests automatiques + lancement des 3 instances |
| **4. Interface** | Shell Tauri, reprise du design, tray, fenêtres console | Parité visuelle avec l'actuel |
| **5. Social** | Amis, chat, notifications | Parité fonctionnelle |
| **6. Validation** | Checklist complète (section 1.5), tableau de mesures final | Version de test installable à côté de l'ancienne |

---

## 5. Protocole de mesure (ancien vs nouveau)

Même machine (i5-14600KF, 32 Go, Windows 11), même connexion, chaque mesure
répétée 5 fois, médiane retenue. Script PowerShell dans `bench/`, qui
additionne **tous** les processus de chaque launcher (Electron : principal,
GPU, renderers ; Tauri : app + WebView2).

| Mesure | Méthode |
|---|---|
| Temps de démarrage | Lancement → fenêtre principale utilisable (à froid après redémarrage, puis à chaud) |
| RAM au repos | Mémoire privée totale, 60 s après ouverture, sur l'accueil |
| RAM dans le tray / en jeu | Même mesure, launcher réduit, Minecraft lancé |
| RAM pendant téléchargement | Pic pendant l'installation complète d'une instance dans un dossier vide |
| CPU au repos | % CPU moyen sur 5 min, fenêtre ouverte puis dans le tray, après 1 h d'ouverture (pour voir la fuite B1) |
| Temps « JOUER → processus Java lancé » | Instance déjà installée, rien à télécharger |
| Taille | Installateur + dossier installé |
| Réactivité | Temps d'ouverture des paramètres et du flyout amis |

Pour mesurer l'ancien launcher, il faut le lancer normalement (il
rafraîchira tes comptes comme d'habitude). Je ne le ferai qu'avec ton
accord.

---

## 6. Décisions à prendre avant de commencer

1. **Interface** : Tauri 2 (recommandé) ou natif complet (plus léger
   encore, mais design entièrement à refaire et news HTML compliquées) ?
2. **Microsoft** : la connexion Microsoft est-elle encore utilisée par des
   joueurs, ou PatateLand est-il 100 % AZauth / hors-ligne ? (Gardée dans le
   plan dans tous les cas, mais priorité différente.)
3. **Mesures de l'ancien launcher** : OK pour que je le lance sur ton PC
   pour le tableau de référence ?
4. **Webhook crash reports** : on garde l'envoi direct vers Discord (même
   faille B5) ou on passe par une petite route sur le site PatateLand ?
