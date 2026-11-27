# Parité avec l'ancien launcher

Retour du 21/11/2026 : le nouveau launcher ne reprenait pas tout ce que
fait l'ancien. Voici l'inventaire complet, relevé dans le code de l'ancien
launcher (lecture seule), et l'état de chaque fonction.

✅ fait · ⏳ à faire · ⚠ partiel

## Démarrage, fenêtre, système

| Fonction de l'ancien launcher | État | Remarque |
|---|---|---|
| Écran de démarrage (logo, citation aléatoire) | ✅ | Dans la fenêtre principale, sans fenêtre en plus |
| Mise à jour automatique du launcher | ⏳ lot 3 | Nécessite une clé de signature et l'organisation des releases |
| Maintenance : message, compte à rebours, liste blanche de pseudos | ✅ | Écran bloquant, rechargement automatique à la fin |
| « Aucune connexion internet » | ✅ | Mieux : copie locale, on peut jouer aux instances installées |
| Une seule instance du launcher | ✅ | |
| Fond aléatoire selon le thème + fond secret (1/200) | ✅ | |
| Barre de titre personnalisée (réduire, agrandir, fermer) | ✅ | |
| Ctrl+W pour fermer | ✅ | |
| Raccourci outils de développement (F12) | ⚠ | Disponible en mode développement uniquement (volontaire) |
| Icône près de l'horloge + menu : ouvrir, jouer à une instance (celles en cours signalées), réglages, déconnexion, quitter | ✅ | Menu natif Windows (l'ancien utilisait une fenêtre HTML) |
| Notification « le launcher tourne en arrière-plan » | ✅ | Une fois par session |
| Lancement avec Windows + démarrer réduit | ✅ | Réduit = **aucune fenêtre** (donc pas de WebView2). L'état affiché est celui réellement enregistré dans Windows |

## Comptes

| Fonction | État | Remarque |
|---|---|---|
| AZauth + double authentification | ✅ | |
| Microsoft | ✅ | Fenêtre officielle isolée (à tester avec ton accord) |
| Hors-ligne | ✅ | |
| Multi-comptes, sélection, suppression | ✅ | |
| Vérification des comptes au démarrage | ✅ | En parallèle, sans écran bloquant, **sans jamais supprimer** |
| Liens « Créer un compte », « Mot de passe oublié » | ✅ | |
| Tête du joueur → profil sur le site (AZauth) | ✅ | |
| Déconnexion depuis l'icône | ✅ | |

## Accueil

| Fonction | État | Remarque |
|---|---|---|
| Actualités RSS ou `/articles`, carrousel 12 s, flèches, points | ✅ | Un seul minuteur, en pause fenêtre cachée |
| Statut du serveur (ping, joueurs) | ✅ | Rafraîchi seulement fenêtre visible |
| Réseaux sociaux (Discord, YouTube, Twitch, GitHub, MineStrator) | ✅ | |
| Encart partenaire MineStrator (code LACRIMO -10 %) | ✅ | |
| Bandeau « laisser un avis », masquable par compte | ✅ | HTML/CSS repris à l'identique (position alignée sur la barre du bas) |
| Écran Paramètres (5 onglets, cartes de comptes, curseur RAM à deux poignées, boutons −/+, fermeture, thème) | ✅ | HTML/CSS de l'ancien launcher repris tels quels (`ui/css/classic.css`, `ui/js/slider.js`) ; ajouts : mode d'affichage, stockage/quarantaine |
| Écran de connexion (Microsoft / hors-ligne / AZauth + A2F) | ✅ | Identique à l'ancien `login.css` |
| Choix de l'instance, liste blanche, descriptions, Event en dernier | ✅ | |
| Badge « En cours » | ✅ | |

## Jeu

| Fonction | État | Remarque |
|---|---|---|
| JOUER : installation, vérification, lancement | ✅ | Beaucoup plus rapide (index) |
| Plusieurs instances en même temps | ✅ | |
| Progression dans la barre des tâches | ✅ | |
| Notifications « Lancement de… », « … a démarré ! », erreur | ✅ | |
| Serveur PatateLand ajouté à la liste multijoueur | ✅ | Sans perte des serveurs du joueur |
| Comportement pendant le jeu (réduire / masquer / laisser) | ✅ | Mieux : fenêtre fermée pour libérer la mémoire |
| Console de jeu (une fenêtre par instance) | ✅ | Couleurs erreurs/avertissements, copier, effacer, limitée à 5 000 lignes |
| Détection de crash + affichage du rapport | ✅ | |
| Envoi des rapports de crash | ⚠ | Préparés localement ; envoi via la future route du site (décidé) |

## Réglages

| Fonction | État |
|---|---|
| RAM (recommandation, limites, alerte petite config) | ✅ |
| Résolution, plein écran | ✅ |
| Afficher la console | ✅ |
| Java personnalisé (choix, retour au Java du launcher) | ✅ |
| Téléchargements simultanés | ✅ |
| Thème auto / sombre / clair | ✅ |
| Lancement avec Windows, démarrer réduit | ✅ |
| Rapports de crash (opt-in) | ✅ |
| Notifications sociales (demandes d'amis, messages) | ✅ à tester avec le site |
| Resource packs et shaders | ✅ |
| Stockage : répartition, ouvrir/vider les logs, vider le cache | ✅ (+ quarantaine restaurable) |

## Amis (lot 2)

Routes de l'API utilisées par l'ancien launcher, toutes connues :
`/api/friends` (liste), `/heartbeat`, `/requests`, `/requests/sent`,
`/request`, `/accept/{id}`, `/decline/{id}`, `DELETE /{id}`,
`/messages/{id}`, `/messages/{id}/typing`, `/messages/unread`,
`/profile/{id}`.

| Fonction | État |
|---|---|
| Liste d'amis, présence en ligne, compteur dans la barre de titre | ✅ à tester avec le site |
| Recherche, ajout, demandes reçues / envoyées, accepter / refuser / retirer | ✅ à tester avec le site |
| Chat multi-fenêtres (déplacer, agrandir, réduire), émojis, émoticônes | ✅ à tester avec le site |
| Badges de non-lus, notifications fenêtre cachée | ✅ à tester avec le site |
| Profil avec rendu du skin | ✅ à tester avec le site |

Développé le 21/11/2026 d'après l'API ci-dessus et le code de l'ancien
launcher (même interface, mêmes textes). **À tester dès le retour du site.**

Fichiers :
- `pl-engine/src/friends.rs` : routes autorisées, vérification des identifiants ;
- `pl-app/src/friends.rs` : jeton, nouvelle tentative après un 401, pause après un 429, tâche de fond ;
- `ui/js/friends.js` et `ui/css/friends.css` : interface.

Différences avec l'ancien launcher :
- **Sécurité.** Le jeton n'est jamais dans l'interface et n'est envoyé qu'en HTTPS, au site du compte. Pseudos et messages sont affichés comme du texte : l'ancien code les insérait en HTML, et un pseudo piégé pouvait y exécuter du code. Avatars acceptés en `https://` seulement. Réponses limitées à 1 Mo, messages à 2 000 caractères.
- **Pendant le jeu.** La présence (60 s), les non-lus (30 s) et les notifications continuent depuis Rust, fenêtre fermée. Les conversations (sondage toutes les 6 s) s'arrêtent avec la fenêtre.
- **Bouton Amis.** Il n'apparaît que pour un compte du site (AZauth).

Tests automatiques :
- routes ;
- identifiants piégés refusés ;
- HTTPS obligatoire ;
- jeton et corps envoyés au site simulé ;
- erreurs 404 et 429 ;
- réponse trop grande.

## Vérifications du lot 1

- Compilation sans avertissement, 51 tests réussis.
- **Pas encore vérifié à l'écran** : écran de démarrage, maintenance,
  bandeaux, menu de l'icône, console, notifications. Ces vérifications
  ouvrent des fenêtres et attendent ton accord.
