# Comptes, UUID hors-ligne et mesures comparatives (étape 2)

Suite de [02-decisions-securite-et-prototype.md](02-decisions-securite-et-prototype.md).

Rappel des décisions :

- PatateBench est validé.
- Le choix Build Tools / xwin est reporté à l'étape Tauri.
- L'extension du site pour les crash reports est mise de côté.
- **Aucune perte de compte en cas de panne.**

---

## 1. Comptes : plus jamais de suppression sur panne

### 1.1 Règle appliquée dans le moteur

| Situation | Ancien launcher | Nouveau moteur |
|---|---|---|
| Site / Microsoft en panne (5xx, 429), coupure réseau, délai dépassé, page HTML de maintenance | **Compte supprimé** | Compte et tokens **conservés**, état « non vérifié ». Le joueur peut jouer avec sa dernière session |
| Le service refuse explicitement la session (token révoqué, mot de passe changé, *refresh token* expiré) | Compte supprimé | Compte **conservé**, état « reconnexion nécessaire ». Le jeu ne se lance pas avec ce compte tant qu'il n'est pas reconnecté |
| Le service revient en panne après un refus | — | Reste en « reconnexion nécessaire » : une panne ne masque pas un refus |
| Fichier de comptes illisible (disque, coupure de courant) | — | Ouverture refusée, **le fichier n'est jamais écrasé**. Écritures atomiques et copie `.bak` de la version précédente |
| Suppression d'un compte | Automatique sur erreur | **Uniquement à la demande du joueur** |

Seul un refus **explicite** compte comme un refus :
- AZauth : réponse `{"status": "error"}` ;
- Microsoft : `invalid_grant`, code `XErr` Xbox, ou 401/403 de Minecraft Services.

Tout le reste (réseau, 5xx, 429, réponse qui n'est pas du JSON) est traité
comme une panne. Dans le doute, on garde.

Les comptes sont vérifiés **en parallèle** au démarrage. L'ancien launcher
les vérifiait un par un, en bloquant l'écran.

### 1.2 Protection des comptes

- `accounts.json` : uniquement pseudo, UUID, type et état, **aucun token**.
- `secrets.dat` : tokens chiffrés par **DPAPI** (Windows). Seule ta session
  Windows sur ce PC peut les déchiffrer, et aucune clé n'est stockée à côté.
  L'ancien launcher, lui, rangeait sa clé dans `key.txt`, dans le même
  dossier que les données.
- Aucun token dans les logs, même partiel : les types sensibles ont un
  affichage de débogage masqué.

### 1.3 Vérification des trois méthodes

| Méthode | Ce qui est vérifié | Comment |
|---|---|---|
| **AZauth** | Connexion, double authentification (A2F), mauvais mot de passe, rafraîchissement avec rotation du token, 503 HTML, connexion refusée, délai dépassé, page de maintenance en 200, refus explicite, refus puis panne | 10 tests automatiques sur faux serveur local, mêmes routes et formats que l'ancien launcher |
| AZauth, **site réel** | Le vrai `patateland.fr`, **en panne pendant le test (503)** : compte conservé en « non vérifié » | Test en conditions réelles. L'ancien launcher aurait supprimé le compte |
| **Microsoft** | Chaîne complète OAuth → Xbox → XSTS → Minecraft, compte sans Minecraft, *refresh token* révoqué, panne Xbox pendant le rafraîchissement, rafraîchissement réussi (XUID, `--userType msa`), lecture de l'adresse de redirection | 6 tests automatiques sur faux serveur local |
| Microsoft, **serveurs réels** | Un code invalide envoyé au vrai `login.live.com` est bien classé « refus » et non « panne » | Test réel, sans aucun compte |
| **Hors-ligne** | Règles de pseudo, UUID identique à Java, même pseudo = même compte, lancement de Forge 1.20.1 jusqu'au menu avec un compte enregistré | Tests automatiques + lancement réel |

**Bilan : 22 tests automatiques au vert, 2 tests sur services réels au vert.**

Restent à faire avec de vrais comptes, quand tu le décideras :

1. **AZauth sur le site en ligne** : connexion réelle avec le compte de test
   PatateBench, puis lancement du jeu et connexion au serveur.
2. **Microsoft de bout en bout** : il faut un compte Microsoft qui possède
   Minecraft. La connexion se fait avec `pl-cli account add-microsoft`, en
   collant l'adresse de la page finale. Ça crée une session indépendante :
   les sessions de l'ancien launcher ne sont pas touchées.
3. La valeur réelle de `online` et de `client_id` dans `/config`, quand le
   serveur répondra.

---

## 2. UUID des comptes hors-ligne : analyse des conséquences

### 2.1 Qui est concerné

- **Comptes AZauth** : l'UUID vient du site. Il est **identique** dans les
  deux launchers.
- **Comptes Microsoft** : l'UUID vient de Mojang. **Identique.**
- **Comptes hors-ligne uniquement.** Or l'écran hors-ligne n'est proposé que
  si `/config` renvoie `online: false`. Si PatateLand est en AZauth (ce que
  montre le système d'amis), **aucun joueur actuel n'a de compte
  hors-ligne**, et l'impact réel est nul. À confirmer quand `/config`
  répondra.

### 2.2 Comportement actuel (constaté dans le code)

`minecraft-java-core` crée un compte hors-ligne avec un UUID **aléatoire**,
et `launcher.js` recrée ce compte à **chaque démarrage du launcher**.
L'UUID hors-ligne change donc à chaque ouverture de l'ancien launcher.

### 2.3 Ce qui dépend de l'UUID côté client

| Donnée | Rangée par UUID ? | Effet d'un changement d'UUID |
|---|---|---|
| Multijoueur sur le serveur PatateLand (mode hors-ligne) | Non : **le serveur recalcule lui-même** l'UUID à partir du pseudo | Aucun |
| Inventaire, position, waystones activés, Curios du joueur hôte en solo | Non : stockés dans `level.dat` | Aucun |
| Statistiques et progrès en solo (`stats/<uuid>.json`, `advancements/<uuid>.json`) | Oui | Repartent de zéro (les anciens fichiers restent sur le disque) |
| **FTB Teams / FTB Quests / FTB Chunks** (instance Extra) en solo | Oui : équipe personnelle liée à l'UUID | Quêtes « réinitialisées », perte de propriété des claims |
| Tombes du mod Corpse (Extra) | Propriétaire enregistré par UUID | Une ancienne tombe peut ne plus être reconnue comme sienne |
| Joueur invité en LAN | Oui (`playerdata/<uuid>.dat` chez l'hôte) | Inventaire de l'invité « perdu » |
| Skin par défaut (sans skin perso) | Calculé depuis l'UUID | Change d'apparence |

Avec l'ancien launcher, toutes les lignes « Oui » **se produisent déjà à
chaque redémarrage du launcher**. Les données ne sont pas effacées : elles
restent rangées sous les anciens UUID.

### 2.4 Options

| | A. UUID calculé depuis le pseudo (recommandé) | B. Garder l'UUID trouvé dans l'ancien launcher, puis le figer |
|---|---|---|
| Au passage au nouveau launcher | L'UUID change une dernière fois, exactement comme au prochain redémarrage de l'ancien | Aucun changement : la dernière session est conservée |
| Ensuite | Stable pour toujours, même après réinstallation ou sur un autre PC | Stable sur ce PC ; perdu en cas de réinstallation sans import |
| Cohérence avec le serveur | Identique à l'UUID que calcule le serveur | Différent du serveur (sans conséquence en multijoueur) |

**Recommandation : A pour les nouveaux comptes, et B à l'import d'un compte
hors-ligne existant** (le moteur sait déjà le faire : `offline_with_uuid`).
Ainsi, le passage au nouveau launcher ne change rien pour personne, et tout
nouveau compte est stable.

Les comportements des lignes FTB, Corpse et LAN se déduisent du
fonctionnement de Minecraft et de ces mods. **Vérification réelle proposée
(5 min, dans PatateBench)** : créer un monde solo sur l'instance Extra,
valider une quête FTB, relancer avec un autre UUID, puis constater. Rien
n'est retenu définitivement avant ce test.

---

## 3. Mesures comparatives

### 3.1 Outils prêts (`bench/`)

| Fichier | Rôle |
|---|---|
| `setup-patatebench.ps1` | Crée l'utilisateur `PatateBench` et le dossier `C:\PatateBench` (à lancer en administrateur) |
| `remove-patatebench.ps1` | Supprime l'utilisateur et son profil après les mesures |
| `measure.ps1` | RAM (privée et working set) et CPU cumulés de tous les processus d'un launcher, CSV + synthèse |
| `run-old.mjs` | Pilote l'ancien launcher sans clic manuel : démarrage → accueil, clic JOUER → Java → menu du jeu. **Refuse de tourner hors de la session PatateBench** |
| `pl-cli --report` | Même découpage des temps pour le nouveau moteur, en JSON |
| `README.md` | Protocole pas à pas, scénarios S1 à S6 |

Je n'ai pas pu créer l'utilisateur moi-même, car ma session n'a pas les
droits administrateur. De toute façon, les mesures de l'ancien launcher
attendent le retour du serveur (`/config` en 503).

### 3.2 Répétition générale côté nouveau moteur (ta session, dossier du projet)

Installation complète dans un dossier vide, puis lancement jusqu'au menu,
avec `measure.ps1` en parallèle :

| Mesure | `pl-cli --report` | `measure.ps1` |
|---|---|---|
| JOUER → installation prête (788 Mo, Forge compris) | 33,0 s | |
| JOUER → processus Java lancé | 33,1 s | |
| Processus Java → menu principal | 10,9 s | |
| RAM max du moteur | 27,6 Mo | 27,6 Mo (working set), 18,2 Mo (privée) |
| RAM du moteur pendant que le jeu tourne | 25,4 Mo | |
| CPU du moteur pendant installation et lancement | | 3 % en moyenne, 5 % au maximum |

Les deux méthodes de mesure donnent la même RAM maximale : l'outil est
validé.

### 3.3 Tableau de comparaison (à remplir dans PatateBench)

| Scénario | Ancien | Nouveau | Écart |
|---|---|---|---|
| S1 Démarrage → accueil | | *(étape Tauri)* | |
| S2 RAM au repos / CPU au repos | | *(étape Tauri)* | |
| S3 Installation Opti complète → menu du jeu | | | |
| S3 RAM max du launcher pendant l'installation | | | |
| S4 JOUER → Java (instance installée) | | | |
| S5 RAM du launcher pendant le jeu | | | |
| S6 Taille installateur / installé | 146 Mo / 398 Mo | 5,4 Mo *(moteur seul)* | |

---

## 4. Ce qui attend le retour des services PatateLand

1. Test réel de l'instance Opti avec ses mods (manifest, `ignored`, `verify`).
2. Lecture de la vraie valeur de `online` et `client_id` dans `/config`.
3. Mesures PatateBench (ancien et nouveau), puis remplissage du tableau 3.3.
4. Connexion AZauth réelle avec le compte de test, et test de l'UUID
   hors-ligne (section 2.4).
