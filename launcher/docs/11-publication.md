# Publication et passage de l'ancien launcher au nouveau

À suivre dans l'ordre. **Aucune étape avant la 4 ne touche les joueurs.**

## Principe

Le dépôt `Suly-ms/PatateLand-Launcher` est un mono-repo : le launcher Rust
est dans `launcher/`, le serveur de fichiers dans `web/` et l'ancien launcher
Electron, qui n'est plus compilé, dans `legacy/electron/`. La branche
`electron` garde l'ancien launcher tel qu'il était publié.

Ce qui se passe quand une release est **publiée** :

| Qui | Ce qu'il fait |
|---|---|
| Ancien launcher Windows | Lit `latest.yml` (dans les 10 minutes), télécharge `PatateLand-win-x64-setup.exe` et le lance avec `--updated`. L'installateur s'installe seul, désinstalle l'ancien launcher et ouvre le nouveau. |
| Ancien launcher Mac / Linux | Trouve `PatateLand-mac-universal.dmg` ou `PatateLand-linux-x64.AppImage` et propose « Télécharger ». |
| Nouveau launcher | Lit `patateland-update.json`, vérifie la signature, puis se met à jour (Windows) ou propose le téléchargement (Mac, Linux). |

Une release en **brouillon** est invisible pour tous les launchers.

## Étape 1 : la clé de signature (une seule fois)

Le nouveau launcher n'accepte une mise à jour que si elle est signée avec la
clé PatateLand. La clé publique est dans le code
(`crates/pl-engine/update-key.pub`). La clé privée est dans
`run/update-signing-key.txt`, un dossier jamais envoyé sur GitHub.

1. **Fais une copie de sauvegarde** de `run/update-signing-key.txt`, dans un
   gestionnaire de mots de passe ou sur une clé USB.
   ⚠️ Si elle est perdue, les launchers déjà installés ne pourront plus
   recevoir de mise à jour automatique. Les joueurs devraient réinstaller à
   la main.
2. Sur github.com, dans le dépôt : *Settings* > *Secrets and variables* >
   *Actions* > *New repository secret*.
   - Nom : `UPDATE_SIGNING_KEY`
   - Valeur : le contenu du fichier (une seule ligne).
3. Ne colle cette clé nulle part ailleurs : ni message, ni Discord, ni fichier
   du projet.

## Étape 2 : sauvegarder l'ancien launcher (GitHub Desktop)

1. Ouvre le dépôt `PatateLand-Launcher` (l'ancien).
2. *Current branch* > *New branch* : nom `electron`, créée à partir de `master`.
3. Clique sur *Publish branch*.

Rien ne change pour les joueurs. Cette branche permet de republier une
version de l'ancien launcher en cas de besoin.

## Étape 3 : envoyer le nouveau launcher (GitHub Desktop)

1. Vérifie la liste des fichiers. Ne doivent **pas** apparaître :
   `launcher/.toolchain`, `launcher/target`, `launcher/target-msvc`,
   `launcher/run`, `launcher/dist`. Ils sont exclus par `launcher/.gitignore`.
2. *Push* sur `all-features` (ou sur `master` une fois la branche fusionnée).
3. Sur github.com, onglet *Actions* : la compilation « Compilation du
   launcher » tourne pendant 20 à 30 min (Windows x64 et ARM64, Mac, Linux,
   tests). Elle ne se lance que si un fichier de `launcher/` (ou le fichier
   `.github/workflows/release.yml`) a changé.
4. Onglet *Releases* : un **brouillon** « PatateLand 2.0.0 » apparaît, avec :
   - les 4 installateurs ;
   - `patateland-update.json` et `patateland-update.json.sig` ;
   - `latest.yml`.

À chaque nouvel envoi, le brouillon est mis à jour.
Une version déjà publiée n'est jamais modifiée : la compilation s'arrête et
demande d'augmenter le numéro de version.

## Étape 4 : bêta fermée

- Télécharge les installateurs depuis le brouillon (connecté à GitHub) et
  donne-les à quelques joueurs.
- Pendant la bêta, l'ancien launcher n'est **pas** désinstallé : l'option est
  proposée mais décochée. Les raccourcis du nouveau s'appellent
  « PatateLand (nouveau) » pour ne pas écraser ceux de l'ancien.
- Sur Mac, l'application n'est pas signée par Apple (c'était déjà le cas de
  l'ancien launcher). Au premier lancement : clic droit > *Ouvrir*.
- Pour l'instant, les deux launchers font aussi apparaître « Éditeur
  inconnu » sous Windows. Seule une signature de code payante enlève cet
  avertissement.

## Étape 5 : la bascule

1. Sur github.com, ouvre le brouillon « PatateLand 2.0.0 » > *Edit* >
   *Publish release*.
2. En 10 minutes maximum, chaque ancien launcher Windows ouvert (ou au
   prochain démarrage) installe le nouveau et se désinstalle. Sur Mac et
   Linux, le bouton « Télécharger » apparaît.
3. Les joueurs se reconnectent et retéléchargent leurs instances. C'est ton
   choix : rien n'est repris de l'ancien launcher. Leurs anciens fichiers de
   jeu restent sur le disque et ne sont pas supprimés.

**Mises à jour suivantes**
1. Augmenter la version à **un seul endroit** : la ligne `version = "…"`
   de `launcher/Cargo.toml` (par exemple 2.0.1).
2. Commit et *Push* sur `master`.
3. Vérifier le brouillon, puis *Publish release*.

## En cas de problème après la bascule

- Une release publiée peut être repassée en brouillon. Les launchers qui ne
  se sont pas encore mis à jour ne la verront plus. Ceux qui l'ont déjà ne
  reviennent pas en arrière tout seuls.
- La correction passe par une nouvelle version (2.0.1) du nouveau launcher,
  qui sera installée automatiquement.

## Notes de version (NOUVEAUTES.txt)

Avant chaque publication, écris les nouveautés dans `launcher/NOUVEAUTES.txt`, une ligne par nouveauté. Elles apparaissent :
- dans la fenêtre « Mise à jour disponible ! » des joueurs (elles font partie
  du manifeste signé) ;
- sur la page de la release GitHub.

Ce que voit un joueur Windows lors d'une mise à jour :
1. Au démarrage : « Mise à jour disponible ! », puis le téléchargement en Mo et
   en %, puis « Installation de la mise à jour… ».
   Launcher déjà ouvert : une notification et une fenêtre « Installer
   maintenant / Plus tard » avec les nouveautés.
2. L'installateur s'ouvre et se déroule seul, sans clic : « Mise à jour… »,
   puis « PatateLand est à jour ! », puis « Relance du launcher… ».
3. Le launcher redémarre et affiche « PatateLand a été mis à jour en version
   X ».
