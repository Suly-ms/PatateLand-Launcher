# Serveur de fichiers PatateLand

Serveur lu par le launcher : configuration, actualités, instances et fichiers
de jeu. Adresse : **`https://patateland.mschnider.fr`** (`DEFAULT_SERVER` dans
`launcher/crates/pl-engine/src/remote.rs`). Changer de domaine demande une
nouvelle version du launcher.

## Routes

| Route | Source | Contenu |
|---|---|---|
| `/` | | État du service (sert au healthcheck) |
| `/config` | `data/config.json` | Maintenance, mode de connexion, dossier de données |
| `/articles` | `data/news.json` | Actualités |
| `/files` | `data/instances.json` | Instances, avec l'URL du manifest de chacune |
| `/manifest/<nom>.json` | `files/<nom>/` | Fichiers de l'instance : chemin, SHA-1, taille, URL |
| `/files/<nom>/<chemin>` | `files/<nom>/` | Fichiers de jeu, servis directement par Apache |

`public/index.php` fait le routage, et `apache.conf` sert les fichiers de jeu.
Les SHA-1 sont gardés en cache et ne sont recalculés que pour un fichier dont
la taille ou la date a changé. Les fichiers cachés (`.quelquechose`) ne sont
ni listés ni servis.

## Données

### `data/config.json`

| Champ | Valeur |
|---|---|
| `maintenance` | `true` bloque le launcher pour tous, sauf les pseudos de `maintenance_whitelist` |
| `maintenance_message` | Texte affiché (`<br>` pour un retour à la ligne) |
| `maintenance_end` | Fin prévue, ISO 8601 (`"2026-12-01T18:00:00Z"`) ou `null` : compte à rebours, puis rechargement automatique |
| `online` | Connexion : URL du site AZauth (`"https://patateland.wstr.fr"`), `true` = Microsoft, `false` = hors-ligne |
| `client_id` | Identifiant d'application Microsoft (si `online: true`) |
| `dataDirectory` | Nom du dossier de jeu |
| `rss` | Flux RSS à la place de `news.json` (facultatif) |

### `data/news.json`

Liste de `{ "title", "content", "author", "publish_date" }`. Le contenu peut
contenir du HTML simple (gras, liens HTTPS…). Le launcher retire tout le
reste (scripts, images, liens `javascript:`).

### `data/instances.json`

Un objet par instance. La clé est le nom, et aussi le nom du dossier dans
`files/` :

| Champ | Rôle |
|---|---|
| `loader` | `minecraft_version`, `loader_type` (`forge`…), `loader_version` |
| `verify` | `true` : les fichiers en trop chez le joueur sont supprimés (sauf `ignored`) |
| `ignored` | Fichiers et dossiers propres au joueur : jamais écrasés ni supprimés |
| `whitelistActive`, `whitelist` | Instance réservée à ces pseudos |
| `status` | Serveur Minecraft affiché (`nameServer`, `ip`, `port`) et ajouté à la liste multijoueur |
| `description` | Texte de l'info-bulle |
| `jvm_args`, `game_args` | Arguments supplémentaires |

> **Valeurs à confirmer.** `instances.json` reprend ce que le dépôt sait des
> instances PatateLand : Opti, Extra et Event, Minecraft 1.20.1 avec
> Forge 47.4.16. La version de Forge de chaque modpack, les listes `ignored`
> et le port du serveur Event viennent de déductions. Les vérifier avant la
> mise en ligne.

### `files/<instance>/`

Le contenu du modpack (`mods/`, `config/`, `defaultconfigs/`…), tel qu'il
doit se retrouver dans le dossier de l'instance du joueur. Rien n'est
versionné dans git : ce dossier est un stockage persistant.

⚠️ Une instance déclarée dont le dossier est absent **ou vide** renvoie une
**erreur 503**, et non une liste vide. Avec `verify: true`, une liste vide ferait supprimer les mods de
tous les joueurs.

## Déployer avec Coolify

1. **DNS** : un enregistrement `A` (et `AAAA` si le serveur a de l'IPv6)
   `patateland.mschnider.fr` → IP du serveur Coolify.
2. **Ressource** : *Projects* → *+ New* → *Public Repository* (ou *Private
   Repository (with GitHub App)*) → `https://github.com/Suly-ms/PatateLand-Launcher`.
3. **Construction** :
   - *Branch* : `master` (`all-features` pour tester) ;
   - *Build Pack* : **Dockerfile** ;
   - *Base Directory* : **`/web`** ;
   - *Ports Exposes* : **80**.
4. **Domaine** : *Domains* = `https://patateland.mschnider.fr`. Le certificat
   HTTPS est automatique.
5. **Redéploiement** : *Watch Paths* = `web/**`. Un changement du launcher ne
   redéploie pas le serveur.
6. **Stockage persistant** (*Persistent Storage* → *Directory Mount*) :

   | Source sur le serveur | Destination | Contenu |
   |---|---|---|
   | `/srv/patateland/files` | `/var/www/files` | Fichiers de jeu |
   | `/srv/patateland/data` | `/var/www/data` | `config.json`, `news.json`, `instances.json` |

   Un dossier monté masque celui de l'image : copier d'abord les trois
   fichiers de `data/` du dépôt dans `/srv/patateland/data`. Ensuite, les
   modifier sur le serveur suffit (maintenance, actualités…), sans
   redéployer.
7. **Variable d'environnement** (facultative mais conseillée) :
   `PL_PUBLIC_URL=https://patateland.mschnider.fr`. Les URLs du manifest
   utilisent alors toujours cette adresse. Sans elle, elles sont déduites de
   la requête et du proxy.
8. **Déployer**, puis vérifier :
   ```bash
   curl https://patateland.mschnider.fr/files
   curl https://patateland.mschnider.fr/manifest/Opti.json | head -c 300
   ```
   Les URLs doivent commencer par `https://`.

## Mettre à jour un modpack

```bash
# Depuis ton PC : copie dans un dossier voisin, puis bascule d'un coup, pour
# qu'aucun joueur ne reçoive une copie à moitié envoyée.
rsync -av --delete ./Opti/ root@serveur:/srv/patateland/files/.Opti-nouveau/
ssh root@serveur 'cd /srv/patateland/files && chmod -R a+rX .Opti-nouveau \
  && rm -rf .Opti-ancien && mv Opti .Opti-ancien && mv .Opti-nouveau Opti'
```

Le manifest se recalcule tout seul, il n'y a rien à redémarrer. Le nouveau
modpack est pris en compte au prochain lancement des joueurs. `.Opti-ancien`
reste disponible pour revenir en arrière.

## Tester en local

```bash
cd web
docker build -t patateland-web .
docker run --rm -p 8790:80 -v "$PWD/files:/var/www/files:ro" patateland-web
# depuis launcher/ :
./target-msvc/release/pl-cli --server http://127.0.0.1:8790 info
```
