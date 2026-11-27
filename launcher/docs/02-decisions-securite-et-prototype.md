# Décisions validées, sécurité et résultats du prototype (étape 1)

Suite de [01-audit-et-architecture.md](01-audit-et-architecture.md).

Décisions prises :

- **Interface** : Tauri 2.
- **Comptes** : toutes les méthodes actuelles sont conservées.
- **Mesures de l'ancien launcher** : pas de lancement tant qu'une méthode sans
  risque n'est pas validée (section 2).
- **Rapports de crash** : envoi via une route du site PatateLand, avec
  protections anti-abus (section 3).
- **Sécurité** : les exigences de la section 4 font partie du cahier des
  charges.

---

## 1. Systèmes d'authentification réellement présents

Relevés dans `launcher.js`, `panels/login.js` et `minecraft-java-core` 4.2.5.

**Une seule méthode de connexion est proposée à la fois.** Le choix dépend du
champ `online` renvoyé par `https://filelauncher.patateland.fr/config` :

| `online` vaut | Écran de connexion affiché | Type enregistré (`meta.type`) | Rafraîchissement au démarrage |
|---|---|---|---|
| une URL (ex. le site PatateLand) | **AZauth** : e-mail + mot de passe, puis code A2F si activé. Routes `<site>/api/auth/authenticate`, `/verify`, `/logout` (API Azuriom) | `AZauth` | `POST /api/auth/verify` |
| `true` | **Microsoft** : fenêtre de connexion Microsoft (OAuth `login.live.com`, `client_id` fourni par `/config`), puis Xbox Live → XSTS → Minecraft Services | `Xbox` | échange du *refresh token* Microsoft |
| `false` | **Hors-ligne** : simple pseudo (3 caractères min., sans espace) | `Mojang` avec `online: false` | nouveau compte hors-ligne recréé |

Points complémentaires :

- **Mojang (ancien compte Mojang, en ligne)** : il n'y a plus d'écran de
  connexion, mais le code sait encore rafraîchir un compte Mojang déjà
  enregistré, via `authserver.mojang.com`. Ce service est fermé par Mojang
  depuis 2022. Ce chemin est conservé pour la compatibilité, avec un message
  clair si un tel compte est rencontré.
- **Le système d'amis et le chat utilisent `online` comme URL d'API.**
  PatateLand fonctionne donc aujourd'hui en mode **AZauth**. Je ne peux pas
  le confirmer directement : `/config` répond 503 depuis le début de l'audit.
- **Multi-comptes** : on peut enregistrer plusieurs comptes. Ils sont tous
  rafraîchis, un par un, à chaque démarrage.
- **Valeur transmise au jeu** : `--userType` vaut `AZauth`, `Mojang` ou `msa`
  selon le type. Aucun `authlib-injector` n'est utilisé.

### Différences de comportement relevées

Rien n'a été modifié côté ancien launcher. Le nouveau en tiendra compte.

| Comportement actuel | Problème | Proposition pour le nouveau launcher |
|---|---|---|
| Si le rafraîchissement d'un compte échoue (site en panne, réseau coupé), **le compte est supprimé** | Le joueur doit se reconnecter alors que son compte est valide | Garder le compte et afficher « reconnexion nécessaire ». Ne supprimer que sur un vrai refus du serveur (401/403) |
| L'UUID d'un compte hors-ligne est **aléatoire et recréé à chaque démarrage** | En solo, les statistiques, progrès et données FTB (quêtes, équipe, claims) sont rangés par UUID et repartent de zéro à chaque redémarrage du launcher. *(Correction : l'inventaire du joueur hôte, lui, est dans `level.dat` et n'est pas concerné.)* | UUID standard calculé depuis le pseudo, à valider : voir l'analyse détaillée dans [03](03-comptes-uuid-et-mesures.md) |
| Les logs affichent les 10 premiers caractères des tokens | Fuite partielle de secrets dans les logs | Aucun token dans les logs, même partiel |

À confirmer quand le serveur reviendra : la valeur exacte de `online`. Les
trois écrans seront implémentés dans tous les cas.

---

## 2. Mesures de l'ancien launcher sans risque pour tes sessions

### 2.1 Ce que modifie un simple lancement (sans cliquer sur JOUER)

| # | Action automatique | Ce qui est modifié |
|---|---|---|
| 1 | Recherche de mise à jour (GitHub) | **Si une version plus récente existe, elle est téléchargée et installée automatiquement**, puis le launcher redémarre |
| 2 | Téléchargement de `/config`, `/files`, des news, et ping du serveur Minecraft (toutes les 15 s) | Rien sur le disque |
| 3 | **Rafraîchissement de chaque compte enregistré** | Les nouveaux tokens sont écrits dans `%APPDATA%\PatateLand\launcher-data.json`. Pour Microsoft, l'ancien *refresh token* est remplacé. **En cas d'échec, le compte est supprimé** (voir section 1) |
| 4 | Présence en ligne (`/heartbeat` toutes les 60 s), compteurs de messages, rafraîchissement du token toutes les 20 min | Tes amis te voient « en ligne » ; le token est réécrit |
| 5 | Initialisation des Paramètres | `configClient` réécrit : RAM par défaut si absente, synchronisation de l'auto-lancement, instance sélectionnée |
| 6 | Paramètres → onglet ressources | Création (si absents) des dossiers `resourcepacks/` et `shaderpacks/` de l'instance sélectionnée |
| 7 | Moteur Chromium | Caches dans `%APPDATA%\PatateLand\` (`Cache`, `GPUCache`, `Local Storage`…) |

Les fichiers de jeu (`%APPDATA%\.patateland`) ne sont pas touchés **tant
qu'on ne clique pas sur JOUER**. Un clic sur JOUER déclenche :

- le re-hachage de tous les fichiers et le téléchargement de ceux qui manquent ;
- la **suppression des fichiers absents du manifest** si l'instance a
  `verify: true` ;
- la réécriture de `servers.dat`.

> ⚠️ Conséquence directe du point 3 : si `/config` répond mais que le site
> AZauth est en panne, ouvrir l'ancien launcher **supprime les comptes
> enregistrés**. C'est vrai pour tous les joueurs, pas seulement pour toi.
> Aujourd'hui `/config` est aussi en panne, donc le launcher s'arrête avant
> cette étape.

L'ancien launcher utilise toujours le vrai dossier `%APPDATA%` de Windows.
Il est impossible de le rediriger vers un dossier de test.

### 2.2 Méthode proposée : un compte Windows dédié aux mesures

1. Créer un utilisateur Windows local `PatateBench` (sans compte Microsoft).
   Il a son propre `%APPDATA%` : **aucun accès à tes comptes, réglages ou
   instances.**
2. Créer **un compte de test sur le site PatateLand** (pas le tien), à
   utiliser pour les deux launchers.
3. Dans la session `PatateBench`, installer l'ancien launcher depuis
   l'installateur 1.4.2 (`dist/PatateLand-win-x64.exe`), puis le nouveau
   quand il existera.
4. Lancer le script de mesure (`bench/measure.ps1`, à écrire) qui additionne
   tous les processus de chaque launcher.
5. Faire les mesures **quand le site et le serveur de fichiers répondent**,
   pour éviter la suppression de compte décrite plus haut.

Pourquoi cette méthode plutôt que le Bac à sable Windows : les mesures se
font sur le vrai matériel, sans couche de virtualisation qui fausserait la
RAM et le CPU. Le Bac à sable reste une alternative si tu préfères ne pas
créer d'utilisateur. Il faut alors activer la fonctionnalité Windows, ce qui
demande un redémarrage.

Seule chose à accepter : la mise à jour automatique (point 1) peut installer
la dernière version publiée dans la session `PatateBench`. C'est sans effet
sur ta session, et on mesure alors la version que les joueurs ont réellement.

---

## 3. Rapports de crash via le site PatateLand

L'adresse du webhook Discord ne sera plus jamais dans le launcher : elle
reste dans la configuration du serveur (`.env`).

### 3.1 Route

`POST https://<site>/api/launcher/crash-reports`, sous forme d'extension
Azuriom / route Laravel, sur le même site que l'authentification.

| Élément | Règle |
|---|---|
| Authentification | `Authorization: Bearer <token AZauth>`, vérifié côté serveur. Les comptes hors-ligne sont acceptés **sans** token, avec des limites plus strictes par IP |
| Contenu | `multipart/form-data` : `meta` (JSON : instance, version du launcher, Minecraft/Forge, OS, CPU, RAM, GPU) + `report` (texte, gzip accepté) |
| Taille | 1 Mo compressé, 4 Mo décompressé, sinon `413` |
| Validation | Texte UTF-8 uniquement ; le rapport doit ressembler à un vrai crash report (`---- Minecraft Crash Report ----` ou format Forge) ; champs `meta` limités en longueur et en valeurs autorisées |
| Réponse | `202 Accepted {id}` ; `429` avec `Retry-After` si une limite est atteinte |

### 3.2 Protections anti-spam et anti-abus

| Protection | Valeur proposée |
|---|---|
| Limite par compte | 3 rapports / 10 min, 20 / jour |
| Limite par IP | 5 / 10 min, 30 / jour (sans token : 2 / 10 min, 10 / jour) |
| Coupe-circuit global | Au-delà de 200 rapports / heure : stockage seul, plus d'envoi Discord, alerte aux admins |
| Dédoublonnage | Empreinte SHA-256 de la cause + des 10 premières lignes de la pile d'appels. Même empreinte dans l'heure : on incrémente un compteur au lieu de reposter |
| Envoi Discord | Par une file d'attente côté serveur, en respectant le `Retry-After` de Discord. Le joueur n'attend jamais Discord |
| Vie privée | Les chemins `C:\Users\<nom>` sont remplacés par `%USERPROFILE%` ; l'IP n'est pas envoyée sur Discord ; conservation 30 jours |
| Bannissement | Un compte ou une IP abusifs peuvent être bloqués depuis l'administration du site |

Côté launcher : envoi uniquement si l'option est cochée (comme aujourd'hui),
un seul rapport par crash, mis en file locale et renvoyé plus tard en cas de
`429` ou sans réseau.

Esquisse Laravel de la limitation (à adapter au site) :

```php
RateLimiter::for('crash-reports', function (Request $request) {
    $user = $request->user();
    return $user
        ? [Limit::perMinutes(10, 3)->by('u'.$user->id), Limit::perDay(20)->by('u'.$user->id)]
        : [Limit::perMinutes(10, 2)->by($request->ip()), Limit::perDay(10)->by($request->ip())];
});
```

La route serveur ne fait pas partie de ce projet : rien ne sera déployé sur
le site sans ton accord. Je pourrai écrire l'extension Azuriom si tu me
donnes accès au code du site.

---

## 4. Exigences de sécurité du nouveau launcher

| Exigence | Mise en œuvre |
|---|---|
| **Aucun secret dans l'exécutable** | Aucune clé ni webhook dans le code ou la config embarquée. Vérification automatique en CI (`gitleaks` + recherche de `discord.com/api/webhooks`). Le `client_id` Microsoft est public par conception (OAuth « public client »), ce n'est pas un secret |
| **Interface sans accès au système** | Tauri : pas de Node dans la page. L'interface ne peut appeler que les commandes du launcher, déclarées une par une dans les *capabilities*. Les plugins `fs`, `shell` et `http` ne sont pas exposés au JavaScript |
| **Contenus serveur isolés** | Les news HTML sont nettoyées en Rust (`ammonia`, liste blanche : paragraphes, gras, italique, liens https, images https). Pseudos, messages et noms de fichiers sont toujours affichés en texte (`textContent`), jamais en HTML |
| **Aucun code exécutable même en cas d'oubli** | Politique CSP stricte : `script-src 'self'`, pas de script inline, pas de `eval`, aucun script distant. Un `<script>` qui passerait le nettoyage ne s'exécuterait pas |
| **Commandes vérifiées côté Rust** | L'interface envoie des identifiants (nom d'instance, id de compte), jamais des chemins. Chaque valeur est vérifiée en Rust (instance connue du serveur, taille bornée). Imports de packs via la boîte de dialogue native ouverte par Rust |
| **Liens externes contrôlés** | Ouverture dans le navigateur uniquement pour une liste de domaines autorisés (site PatateLand, Discord, MineStrator…) et en `https` |
| **Comptes protégés** | Tokens stockés dans le Gestionnaire d'identification Windows (chiffrement lié à la session Windows). Le fichier de réglages ne contient aucun secret. Aucun token dans les logs |
| **Fichiers téléchargés sûrs** | HTTPS uniquement ; SHA-1 vérifié pendant le téléchargement ; un manifest ne peut pas écrire hors du dossier de l'instance (`../`, chemins absolus refusés). **Déjà fait et testé dans le prototype** |
| **Mises à jour signées** | Signature ed25519 du *updater* Tauri : la clé privée n'existe que dans les secrets GitHub Actions ; une mise à jour non signée est refusée. Signature Authenticode de l'exe recommandée (certificat payant) |
| **Lancement du jeu sans injection** | Arguments passés en tableau au processus Java, sans passer par un shell. **Déjà le cas dans le prototype** |
| **Dépendances surveillées** | `cargo audit` / `cargo deny` en CI |

---

## 5. Résultats du prototype (étape 1)

### 5.1 Ce qui a été construit

Dans `crates/` :

- `pl-engine` : le moteur, indépendant de toute interface (environ 1 900 lignes, commentaires compris) ;
- `pl-cli` : un outil en ligne de commande pour le tester.

| Brique | État |
|---|---|
| Téléchargements parallèles, `.part` + renommage atomique, reprise après coupure, 3 essais | ✅ testé (dont reprise réelle : seuls les octets manquants sont téléchargés) |
| Index de vérification (taille + date + SHA-1), mode « Réparer » | ✅ testé |
| Java 17 officiel Mojang | ✅ |
| Minecraft 1.20.1 : version, bibliothèques, natives, assets, logs | ✅ |
| **Forge 1.20.1-47.4.16** : installateur, 6 étapes de patch, bibliothèques | ✅ |
| Lancement Forge, compte hors-ligne, `logs/latest.log` créé | ✅ menu principal atteint |
| Lecture de `/config`, `/files`, manifest d'instance (format actuel) | ✅ codé, ⏳ non testé en réel (serveur en 503) |
| Synchronisation d'instance : réparation, `ignored` respecté, nettoyage `verify` | ✅ testé avec un manifest local au même format |
| Protection contre les chemins piégés dans un manifest | ✅ testé (`../evil.txt` refusé) |

### 5.2 Mesures (PC de dev : i5-14600KF, 32 Go, SSD, fibre)

| Mesure | Résultat |
|---|---|
| Installation complète à vide (Java 17 + Minecraft 1.20.1 + 3 900 assets + Forge) | **34 s** : 788 Mo téléchargés en 16,7 s, Forge installé en 17 s |
| Même commande quand tout est déjà installé | **0,4 s** |
| Lancement → menu principal de Forge 1.20.1 (instance sans mods) | **11,2 s** |
| Vérification de 4 084 fichiers (794 Mo), méthode de l'ancien launcher (un par un) | 1,45 s |
| Même chose, SHA-1 complet en parallèle | 0,30 s |
| Même chose, avec l'index (nouveau launcher) | **0,03 s** (≈ 50× plus rapide) |
| Mémoire maximale du moteur pendant l'installation | **30 Mo** |
| Mémoire maximale du moteur pendant que le jeu tourne | **22 Mo** |
| Taille de l'exécutable de test | 5,4 Mo |

Pour lire ces chiffres honnêtement :

- La méthode « ancien launcher » est **réimplémentée en Rust** et mesurée
  avec les fichiers déjà en cache mémoire, sur un SSD rapide. Le vrai
  launcher Electron, sur un PC modeste à disque dur et juste après un
  redémarrage, sera nettement plus lent. Le tableau comparatif réel viendra
  des mesures de la section 2.
- Les mods de l'instance Opti n'ont pas pu être testés : le serveur de
  fichiers répond 503. Le temps de lancement mesuré est celui d'un Forge sans
  mods.
- Seul le compte hors-ligne a été utilisé. AZauth et Microsoft arrivent à
  l'étape 3.

### 5.3 Outils de compilation (tout reste dans le dossier du projet)

- Rust 1.100 installé dans `.toolchain/` (rien dans le PATH système). On
  l'active avec `source env.sh`.
- Visual Studio n'étant pas installé, la cible utilisée est
  `x86_64-pc-windows-gnu`. Elle a besoin de `as.exe` et `dlltool.exe`, que
  Rust ne fournit pas : ils ont été extraits de MinGW-w64 portable (WinLibs
  16.2) dans `.toolchain/binutils/`.
- **Décision à venir pour l'étape 4 (Tauri)** : Tauri est surtout testé avec
  la cible MSVC. Deux options :
  1. installer les *Visual Studio Build Tools*, ce qui touche au système ;
  2. récupérer les bibliothèques MSVC en portable avec `xwin`, dans
     `.toolchain/`.

  Je te demanderai avant.

---

## 6. Prochaine étape proposée (étape 2-3)

1. **Dès que le serveur PatateLand répond** : test réel de l'instance Opti
   (mods, `ignored`, `verify`) et des trois instances.
2. Script de mesure `bench/measure.ps1`, puis mesures de référence dans la
   session `PatateBench` (si tu valides la section 2.2).
3. Authentification : AZauth + A2F, Microsoft, hors-ligne, rafraîchissement
   sans suppression abusive, stockage dans le Gestionnaire d'identification.
4. Import en lecture seule des comptes et réglages de l'ancien launcher.
5. `servers.dat`, crash reports (côté launcher), réglages.
