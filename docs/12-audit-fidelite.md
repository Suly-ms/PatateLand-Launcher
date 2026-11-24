# Audit de fidélité : ancien launcher → PatateLand Rust

Date : 24/11/2026.

**Méthode.** Relecture complète de l'ancien launcher (lecture seule) :
- fenêtres : `app.js`, `windows/*.js`, `trayMenu.html`, `log.html` ;
- écrans : `launcher.js`, `index.js`, `panels/*.js` et leurs CSS.

Chaque comportement est comparé au code du nouveau launcher. Rien n'a été
modifié pendant l'audit.

Légende : ❌ manquant · ⚠️ différent · 🐞 ne fonctionne pas · ✅ identique · ⭐ amélioration volontaire.

## 1. Notifications

L'ancien launcher n'avait pas de système maison. Il utilisait les
**notifications Windows** (`new Notification`, icône PatateLand). Pour les
messages dans la fenêtre, il utilisait une **pop-up** (voir § 4).

| Notification (ancien) | Nouveau |
|---|---|
| « Lancement de X… » | 🐞 codée, n'apparaît pas |
| « X a démarré ! » | 🐞 codée, n'apparaît pas |
| « Erreur au lancement de X. » | 🐞 codée, n'apparaît pas |
| « Le launcher tourne en arrière-plan… » au 1er passage dans le tray, **clic = rouvre** | ⚠️ seulement pendant une partie, pas de clic (et 🐞) |
| Mise à jour disponible, **clic = téléchargement** (Mac/Linux) | ⚠️ sans clic (et 🐞) |
| Amis : demande reçue, demande acceptée, message | 🐞 codées, n'apparaissent pas |
| Actualités, fin de téléchargement | — n'existaient pas dans l'ancien |

**Cause du 🐞.** Une fois installé, le launcher se présente à Windows sous
l'identité `fr.patateland.launcher.rust` (AppUserModelID). Notre installateur
**n'enregistre pas** cette identité, alors que l'installateur NSIS le faisait.
Windows rejette donc les notifications sans rien afficher.

## 2. Menu de l'icône (zone de notification)

| | Ancien | Nouveau |
|---|---|---|
| Type | ⚠️ **fenêtre personnalisée** 240 px, au thème du launcher | menu natif Windows |
| Contenu | en-tête (logo + « PatateLand Launcher »), Ouvrir le launcher, Jouer ▸ (sous-liste dépliante avec badge « En cours »), Paramètres, séparateur, **Se déconnecter** (rouge au survol), séparateur, Quitter | mêmes actions ✅ |
| Style | fond `#1b1d24`, bordure fine, arrondis 8 px, survol orange `#f27312`, chevron qui tourne, sous-menu animé | ❌ |
| Ouverture | clic gauche **et** clic droit ouvrent le menu, double-clic ouvre le launcher. Il se ferme au clic ailleurs ou sur Échap, et se place au-dessus de l'icône | ⚠️ clic gauche = ouvre le launcher, clic droit = menu natif |
| Thème clair | fond `#f2f2f2` | ❌ |

## 3. Fenêtre et barre de titre

| | Ancien | Nouveau |
|---|---|---|
| Bouton « réduire » | ⚠️ **cache dans le tray** (Windows/Linux) + notification la 1re fois | réduit dans la barre des tâches |
| Bouton « fermer », Ctrl+W | quitte | ✅ |
| Outils de développement (Ctrl+Maj+I, F12) | ouverts même chez les joueurs | ⭐ désactivés chez les joueurs (sécurité) |
| Démarrer réduit | ✅ | ✅ |

## 4. Messages dans la fenêtre

| | Ancien | Nouveau |
|---|---|---|
| Pop-up | ⚠️ **carte vitrée centrée** 450 px : titre souligné, texte rouge pour les erreurs, bouton orange « OK », fond flouté | boîte de dialogue différente (style, boutons) |
| Petits messages en bas (« Compte ajouté », etc.) | n'existaient pas | ⚠️ ajoutés (toasts) |
| « Vérification de vos comptes en cours… » au démarrage | pop-up bloquante | ⭐ vérification en arrière-plan, sans bloquer |

## 5. Écran de démarrage

| | Ancien | Nouveau |
|---|---|---|
| Forme | ⚠️ **petite fenêtre séparée** 400 × 500, sans bordure | écran dans la grande fenêtre |
| Fond | **image de fond aléatoire** | dégradé sombre |
| Animation | logo qui apparaît puis remonte, citation et statut en fondu | logo qui grossit |
| Statut | « Recherche de mise à jour… », barre de progression, « Démarrage du launcher », maintenance avec compte à rebours | ⚠️ partiel |
| Sans internet | « Aucune connexion internet… Arrêt dans 5s » | ⭐ le launcher s'ouvre avec les instances déjà installées |

## 6. Choix de l'instance

| | Ancien | Nouveau |
|---|---|---|
| Fenêtre | ⚠️ titre « CHOISISSEZ VOTRE INSTANCE... » souligné orange, croix en haut à gauche, animation « pop » | liste simple |
| Lignes | nom centré ; instance active en **dégradé orange avec un point blanc** ; icône **« i »** avec la description en info-bulle ; badge « En cours » | nom + description en texte, bordure orange |

## 7. Console de jeu

| | Ancien (640 lignes) | Nouveau (90 lignes) |
|---|---|---|
| En-tête | logo, titre, **pastille d'état** (en cours / arrêté / crash) | titre simple |
| Lignes | **heure** devant chaque ligne, **couleurs** (info / avertissement / erreur) | texte brut |
| Compteurs | lignes, avertissements, erreurs | ❌ |
| Crash | **carte « rapport de crash »** dépliable : ouvrir le fichier, copier | ❌ |
| Défilement | bouton « revenir en bas » | ❌ |
| Effacer, réduire, fermer | ✅ | ✅ (+ copier) |

## 8. Accueil

| | Ancien | Nouveau |
|---|---|---|
| Joueur autorisé pendant une maintenance | ⚠️ **bandeau** « ⚠ message — Fin dans 2h 05min » | rien |
| Joueur non autorisé | bloqué avec compte à rebours | ✅ |
| Actualités | rechargées **toutes les 3 min** | ⚠️ une seule fois |
| Statut du serveur | toutes les **15 s** | ⚠️ toutes les 30 s |
| Bandeau d'avis, encart MineStrator, réseaux, tête du joueur (profil du site) | | ✅ |

## 9. Déjà identiques

Paramètres (5 onglets), connexion (3 méthodes + A2F), comptes,
resource packs et shaders, stockage, amis et chat, raccourci Ctrl+W, thèmes,
progression dans la barre des tâches, démarrage avec Windows, lancement depuis
le tray, maintenance bloquante.

## 10. Différences gardées (décidées ensemble)

- Rapports de crash : l'ancien les envoyait à un webhook Discord dont
  l'adresse était **dans l'exécutable**. Ils restent sur le PC en attendant
  la route sécurisée du site.
- Nouveau compte, réglages et instances séparés de l'ancien launcher.
- Plus de suppression de compte si le site est en panne.

## 11. Corrections faites (24/11/2026)

Choix validés : l'écran de démarrage reste celui du nouveau launcher ; les
petits messages de confirmation sont gardés, aux couleurs de PatateLand ; les
erreurs passent par la pop-up de l'ancien.

| # | Correction | Vérification |
|---|---|---|
| 1 | **Notifications** : le launcher enregistre lui-même son identité Windows (nom « PatateLand », icône), donc sans réinstallation. Un clic rouvre le launcher ; sur Mac/Linux, le clic d'une mise à jour ouvre le téléchargement. Message « tourne en arrière-plan » une fois par session, comme l'ancien. Identité retirée à la désinstallation. | À confirmer sur ton PC |
| 2 | **Menu de l'icône** : fenêtre personnalisée identique à l'ancienne (`tray.html`, `css/tray.css`), thème clair compris. Clic gauche/droit = menu, double-clic = launcher. Fermeture au clic ailleurs ou avec Échap. Placé au-dessus de l'icône, dans l'écran. Créé à l'ouverture, détruit après 2 min sans servir. Linux garde le menu natif (clics non transmis par le système). | Rendu identique à l'ancien (outil de comparaison) ; ouverture réelle à confirmer |
| 3 | **Réduire** = passe dans le tray (Windows/Linux), réduction classique sur Mac | À confirmer |
| 4 | **Pop-up** de l'ancien (carte vitrée, texte rouge pour les erreurs, bouton orange) ; messages de confirmation en carte vitrée bordée d'orange | Rendu vérifié |
| 5 | **Choix de l'instance** identique : même taille (90 %), point blanc, « ? » avec info-bulle, badge « En cours » ; instances réservées masquées ; pas de bouton s'il n'y a qu'une instance | Rendu identique à l'ancien |
| 6 | **Console** de l'ancien : état du jeu, heure et couleur par ligne, compteurs, messages log4j regroupés, carte du rapport de crash (afficher, ouvrir, copier), bouton « revenir en bas ». En plus : « Copier » et limite de 5 000 lignes. Le rapport n'est lisible que s'il vient d'un dossier `crash-reports` du jeu. | Rendu vérifié avec une partie simulée |
| 7 | **Bandeau de maintenance** pour les joueurs autorisés. Dans l'ancien, il était créé sans aucun style, donc invisible en pratique. Actualités rechargées toutes les 3 min (seulement si elles ont changé) ; statut toutes les 15 s. | Rendu vérifié |

Tous les rendus : `tools/visual` (scénarios `s7` à `s13`).

## 12. Écran de lancement, notifications, menu de l'icône (24/11/2026, suite)

### Causes trouvées

- **Menu de l'icône, clic droit sans effet** : la fenêtre du menu était créée
  directement dans le gestionnaire du clic. Sous Windows, cela bloque
  (limite de WebView2 documentée par Tauri : « deadlocks when used in event
  handlers »). Le même risque existait pour le double-clic sur l'icône, le
  clic sur une notification et le second lancement du launcher.
- **Notifications « jamais vues »** : l'historique de Windows (lu sur une
  copie) contient bien la notification « Le launcher tourne en
  arrière-plan… » de 18 h 51. Les notifications sont donc acceptées par
  Windows. Aucune autre n'a été envoyée : le serveur PatateLand étant
  injoignable, aucune partie n'a pu démarrer. De plus, Windows 11 range les
  notifications dans le centre (Windows + N), sans les afficher, quand « Ne
  pas déranger » est actif, ce qui arrive automatiquement pendant les jeux.

### Corrections

- Les fenêtres sont créées sur un fil séparé (`window::show_main_later`,
  `tray::toggle`), comme le recommande Tauri.
- Le menu ne se rouvre plus quand on clique sur l'icône pour le fermer.
- « Paramètres » depuis le menu, fenêtre fermée : le launcher s'ouvre
  directement sur les paramètres.
- Nouvelle notification « Téléchargement terminé : X Mo pour Opti » (quand il
  y a eu un téléchargement).
- Bouton **« Envoyer une notification de test »** dans Paramètres >
  Launcher, avec l'explication sur « Ne pas déranger ».
- **Écran de lancement** : une carte au-dessus de la barre du bas affiche
  quatre étapes, Préparation, Vérification, Téléchargement et Lancement.
  - Chaque étape a sa barre et le pourcentage de l'étape en cours.
  - Une ligne d'état indique ce que fait le launcher : nombre de fichiers
    vérifiés, Mo téléchargés et débit.
  - Fin en vert « Bon jeu ! », ou en rouge si le lancement échoue.
  - La vérification des fichiers est maintenant comptée par le moteur
    (`Progress::checked_*`).

### Vérifié

- Compilation sans avertissement, 82 tests.
- Écran de lancement rendu à chaque étape avec un lancement simulé :
  scénario `tools/visual/s14-launch.json`.

### À valider sur ton PC

- Clic droit et clic gauche sur l'icône : le menu s'ouvre au-dessus de l'icône.
- Double-clic sur l'icône : le launcher s'ouvre.
- Bouton « Envoyer une notification de test » : la notification apparaît, et
  un clic dessus rouvre le launcher.
- Lancement réel d'une instance : écran de lancement et notifications. Ce test
  attend le retour du serveur.
