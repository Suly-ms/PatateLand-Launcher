# Vrai modpack sans serveur et fonctions du moteur (étape 2 bis)

Le site et le serveur de fichiers PatateLand sont coupés (hébergement non
renouvelé). Cette étape avance sur tout ce qui n'en dépend pas.

## 1. Test du modpack Extra sans le serveur

Avec ton accord, le **contenu du modpack** Extra a été **copié** (lecture
seule) depuis la copie de développement de l'ancien projet vers
`run/mock-server/files/Extra` :

- copié : `mods`, `config`, `defaultconfigs`, `kubejs`, `resourcepacks`,
  `shaderpacks`, `fancymenu_data`, soit 2 578 fichiers, 247 mods, 925 Mo ;
- non copié : les données de joueur (mondes, logs, `options.txt`, caches) et
  le prototype cosmétiques.

`tools/mock-file-server.mjs` est un faux serveur local qui reproduit les
routes du vrai : `/config`, `/files` et le manifest d'instance. Le moteur
suit donc le même chemin qu'avec le serveur PatateLand.

| Mesure | Résultat |
|---|---|
| Synchronisation complète du modpack (2 578 fichiers, 918 Mo, serveur local) | 1,8 s (non représentatif du réseau) |
| Revérification des 2 578 fichiers au lancement suivant | **0,05 s** |
| Forge 1.20.1 + **298 mods** (247 fichiers + mods embarqués) → menu principal | **45 à 85 s** selon les lancements (cache disque, 6 Go de RAM) |
| RAM du moteur pendant que le modpack tourne | 22 à 26 Mo |

Erreurs du jeu analysées : toutes viennent du contenu des mods (modèles
manquants, compatibilités optionnelles, vérificateurs de mises à jour),
**aucune du launcher**.

### ⚠ Problème trouvé dans les données PatateLand

4 resource packs d'Extra ne sont **pas des archives mais des pages HTML de
7 571 octets** :

- Blue & Pink Nebula ;
- Vanilla Experience+ (×2) ;
- Torches Reimagined.

Leurs noms contiennent un `§` mal encodé (`u00a7`). C'est probablement une
page d'erreur du serveur enregistrée à la place du fichier. La copie de
l'ancien launcher a le même problème, donc **ces packs sont sans doute
cassés chez les joueurs aussi**. À vérifier sur le serveur quand il
reviendra (renommer ces fichiers sans `§` règlerait sûrement le problème).

Le nouveau moteur refuse tout fichier dont le SHA-1 ne correspond pas au
manifest.

#### Fiche détaillée (vérifications du 20/11/2026)

Fichiers dans `instances/Extra/resourcepacks/` de la copie de développement
de l'ancien launcher (lus sans modification) :

| Nom du fichier sur le disque | Taille | SHA-1 | Contenu réel |
|---|---|---|---|
| `u00a71Blue u00a7f& u00a7dPink u00a7fNebula.zip` | 7 571 o | `278a4b24…4c5a5045` | page HTML « 404 Not Found » |
| `u00a76u00a7lVanilla Experience+u00a70.zip` | 7 571 o | `278a4b24…4c5a5045` | page HTML « 404 Not Found » |
| `u00a7bu00a7lVanilla Experience+u00a70.zip` | 7 571 o | `278a4b24…4c5a5045` | page HTML « 404 Not Found » |
| `u00a7eTorchesu00a78-u00a7eReimaginedu00a70_u00a78[v1.8]u00a70.zip` | 7 571 o | `278a4b24…4c5a5045` | page HTML « 404 Not Found » |

SHA-1 complet, identique pour les 4 :
`278a4b2443807c369f250e42286c131c4c5a5045`.

Ce que ça montre :

1. Le serveur a répondu **404** (fichier introuvable) pour ces 4 adresses.
   Cause probable : le `§` (`§`, code couleur Minecraft) des noms
   d'origine, mal converti en `u00a7` dans les noms ou dans les liens.
2. L'**ancien launcher a enregistré la page 404 comme si c'était le pack**,
   sans vérifier le code HTTP. Il ne l'a jamais corrigé ensuite, sans doute
   parce que `resourcepacks` fait partie des fichiers « ignorés » après le
   premier téléchargement.
3. Le nouveau moteur refuse toute réponse HTTP en erreur, et tout fichier
   dont le SHA-1 diffère du manifest. Il n'aurait donc pas installé ces pages.

À faire quand le serveur reviendra (rien ne sera modifié sur le serveur réel
sans t'en informer avant) :

- [ ] retrouver les 4 fichiers d'origine sur le serveur et leur vrai nom ;
- [ ] vérifier leurs liens dans le manifest de l'instance Extra (URL, SHA-1, taille) ;
- [ ] proposer la correction (renommer sans `§`, ou corriger l'encodage des liens) ;
- [ ] vérifier ensuite qu'un joueur qui a déjà les fausses archives reçoit bien les vraies.

**Point à décider.** Dans le nouveau moteur comme dans l'ancien, un fichier
« ignoré » qui existe déjà n'est jamais retéléchargé : c'est ce qui protège
les réglages modifiés par le joueur. Si `resourcepacks` reste ignoré, les
joueurs qui ont déjà les fausses archives **ne recevront pas les vraies**,
même une fois le serveur corrigé. Pistes :

- retirer `resourcepacks` des fichiers ignorés (ce ne sont pas des réglages) ;
- ou remplacer quand même un fichier ignoré qui n'est manifestement pas un
  fichier valide (ex. un `.zip` qui commence par `<html>`) ;
- ou donner aux packs corrigés un nouveau nom de fichier.

#### Les trois solutions comparées

| | 1. Retirer `resourcepacks` des fichiers ignorés | 2. Remplacer un fichier ignoré manifestement invalide | 3. Nouveau nom de fichier sur le serveur (sans `§`) |
|---|---|---|---|
| Corrige les joueurs déjà touchés | Oui | Oui, avec le nouveau launcher uniquement | Oui, **avec les deux launchers** |
| Risque pour les joueurs | **Élevé** : avec `verify: true`, tout fichier absent du manifest et non ignoré est supprimé. **Les packs ajoutés par les joueurs seraient effacés** | Faible : seul un `.zip`/`.jar` connu du manifest, à l'empreinte différente **et** qui n'est pas une archive valide est remplacé. Un vrai pack modifié n'est jamais touché | Aucun |
| Corrige la cause | Non | Non | **Oui** : plus de `§` qui casse les liens |
| Effort | Config serveur | Code dans le nouveau launcher (+ tests) | Renommer 4 fichiers et régénérer le manifest |
| Reste-t-il quelque chose ? | Non | Non | Les 4 fausses archives restent chez les joueurs, sous l'ancien nom. Inoffensives : Minecraft les ignore déjà, mais c'est du désordre |

**Décision (20/11/2026) : solutions 3 + 2 validées.** La solution 2 est
implémentée (voir plus bas). La 3 sera faite sur le serveur réel quand il
reviendra, **après t'en avoir informé**.

**Recommandation initiale : 3 + 2.** La solution 3 corrige la cause et répare
immédiatement les joueurs des deux launchers, sans aucun risque. La 2,
intégrée au nouveau launcher, empêche qu'un fichier cassé de ce genre
survive à l'avenir. Pour les 4 fausses archives laissées sous l'ancien nom,
le nouveau launcher pourra les signaler, voire les déplacer dans un dossier
de quarantaine, plutôt que de les supprimer. **La solution 1 est à écarter**
à cause de l'effacement des packs personnels.

#### Solution 2 implémentée : détection prudente et quarantaine

Règles, dans `instance.rs` et `quarantine.rs` :

| Cas | Action |
|---|---|
| Fichier du manifest **ignoré**, `.zip`/`.jar`, empreinte différente **et** ne s'ouvre pas comme une archive | Quarantaine, puis vraie version téléchargée |
| Même cas, mais l'archive s'ouvre (pack **modifié par le joueur**) | **Jamais touché** |
| Fichier ignoré qui n'est pas une archive (`options.txt`…) | **Jamais touché** |
| `.zip`/`.jar` hors manifest qui n'est pas une archive **et** ressemble à une page web | Quarantaine (avant le nettoyage `verify` : jamais supprimé) |
| `.zip`/`.jar` hors manifest abîmé autrement (ex. tronqué) | **Laissé en place**, seulement signalé |

La quarantaine est rangée dans `.pl/quarantine/<instance>/<id>/`, **hors du
dossier de l'instance** : le nettoyage automatique ne peut pas l'atteindre.
Un index garde le chemin d'origine, la raison, la taille et la date.
`pl-cli quarantine` liste les fichiers, `pl-cli quarantine --restore <id>`
remet un fichier à sa place. La restauration **refuse d'écraser** un fichier
existant.

Vérifications :

- **4 tests automatiques** : page 404 remplacée et restaurable, pack modifié
  par le joueur intact, ancien nom mis en quarantaine (restauration refusée
  si la place est prise), pack personnel / archive tronquée / `options.txt`
  intacts.
- **Simulation réelle du scénario 3 + 2**, sur une instance séparée
  `ExtraSim` avec les 60 vrais packs, et un faux serveur « corrigé » sans les
  4 packs au nom cassé. Résultat : **4 fausses archives en quarantaine,
  56 vrais packs intacts, 0 téléchargement**, puis restauration réussie d'un
  fichier.

**Incident pendant la simulation, et la règle qui en découle.** Un premier
essai a tourné avec un `pl-cli.exe` pas encore recompilé : `cargo test -p
pl-engine` ne reconstruit pas l'exécutable. Cet ancien binaire a supprimé
les 4 fausses archives de la copie `ExtraSim` via le nettoyage `verify`.
C'était exactement l'ancien comportement, et il ne concernait que des
copies : les originaux de `run/game/instances/Extra` et
`run/mock-server/files/Extra` sont intacts. **Règle : toujours `cargo build
--release` sur tout le projet avant un test avec `pl-cli`.**

Les fichiers de simulation (`run/game/instances/ExtraSim`,
`run/mock-server/sim`) sont conservés dans `run/` avec le reste.

## 2. Fonctions du moteur ajoutées

| Fonction | Ce qui change par rapport à l'ancien launcher | Vérification |
|---|---|---|
| **`servers.dat`** (serveur PatateLand en tête de la liste multijoueur) | Tous les champs des serveurs du joueur sont gardés (icônes, réglages). Un fichier illisible est sauvegardé au lieu d'être perdu. Écriture **avant** le lancement, atomique. Adresse lue dans `status` de `/files`, sinon même table que l'ancien | 4 tests + **relecture/réécriture identique à l'octet** du vrai `servers.dat` écrit par l'ancien launcher |
| **Réglages** | Mêmes réglages que `configClient`, mêmes valeurs (`close-none`/`close-launcher`/`close-window`). Fichier illisible mis de côté, jamais écrasé. Valeurs vérifiées (RAM ≤ 80 %, multiples de 0,5 Go, résolution, téléchargements simultanés) | 4 tests + bout en bout |
| **RAM recommandée** | Même calcul que l'ancien (`computeDefaultRam`), borné à 80 %. Un profil copié depuis un PC plus puissant est ramené aux limites de la machine | Comparé à l'ancien pour 2, 4, 8, 15,9, 16 et 32 Go |
| **Détection de crash** | Arrêt anormal détecté, dernier rapport retrouvé, infos système lues dans Windows (OS, CPU, RAM, GPU). **Chemins personnels masqués** (`%USERPROFILE%`). Si l'envoi est activé, le rapport est mis en attente de la route du site, rien n'est envoyé | 2 tests + arrêt anormal réel |
| **Resource packs / shaders** | Liste, ajout (`.zip`), suppression. Un nom piégé (`../servers.dat`) est refusé | 1 test + bout en bout |
| **Stockage** | Mêmes catégories. Calcul en parallèle et hors interface (1,8 Go analysés en 0,02 s). Nettoyage des logs ou du cache sans toucher à Java ni aux instances | 1 test + bout en bout |
| **RAM en ligne de commande** | `--ram-max` est maintenant soumis aux mêmes limites que les réglages : un essai avec 99 999 999 Mo avait fait démarrer le jeu | bout en bout |

**37 tests automatiques au vert** (20 unitaires + 17 sur les comptes), plus
4 tests à la demande sur services ou fichiers réels.

## 3. Toujours en attente du retour du serveur

1. Test réel des instances Opti, Extra et Event depuis le vrai serveur.
2. Vraies valeurs de `/config` (`online`, `client_id`).
3. Connexion AZauth réelle, test de l'UUID hors-ligne.
4. Mesures PatateBench de l'ancien launcher.
