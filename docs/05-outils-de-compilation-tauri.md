# Outils de compilation pour l'étape Tauri : Build Tools ou xwin

**Rien n'a été installé.** Ce document sert à choisir.

## Pourquoi il faut changer quelque chose

Aujourd'hui le moteur se compile avec la variante **GNU** de Rust
(`x86_64-pc-windows-gnu`). On l'a choisie parce que Visual Studio n'est pas
installé, et tout tient dans `.toolchain/`. Ça suffit pour le moteur et la
ligne de commande.

Tauri sur Windows est conçu et testé pour la variante **MSVC**
(`x86_64-pc-windows-msvc`). Elle a besoin de trois choses que Rust ne
fournit pas :

1. les bibliothèques C de Microsoft (CRT) et du SDK Windows ;
2. un éditeur de liens compatible MSVC ;
3. un compilateur de ressources, pour intégrer l'icône et le manifeste
   Windows dans l'exe.

C'est aussi ce qu'utilise la CI GitHub (`windows-latest`), qui fabriquera
l'installateur.

État de ton PC (lecture seule) : pas de Visual Studio ni de SDK Windows,
**WebView2 Runtime 157 déjà présent** (Windows 11), 682 Go libres.

---

## Option 1 : Visual Studio Build Tools (installation Windows)

Outils officiels de Microsoft, sans l'éditeur Visual Studio. On installe la
charge de travail « Développement Desktop en C++ » : compilateur MSVC + SDK
Windows 11.

**Avantages**
- C'est **la configuration officielle** de Rust et de Tauri sur Windows :
  toute la documentation et les exemples la supposent.
- **Identique à la CI GitHub** : ce qui compile chez toi compile pareil pour
  l'installateur des joueurs.
- Tout fonctionne directement, y compris les dépendances qui contiennent du
  code C, qui pourraient arriver avec les plugins Tauri (notifications,
  mise à jour…).
- Débogage possible avec les outils Microsoft si besoin.

**Inconvénients**
- Installation **sur le système**, avec droits administrateur.
- Environ **6 à 8 Go** sur `C:` (`C:\Program Files (x86)\Microsoft Visual
  Studio`, `C:\Program Files (x86)\Windows Kits`).
- Ajoute le « Visual Studio Installer », qui propose ses propres mises à jour.
- La désinstallation (via le Visual Studio Installer) laisse quelques
  traces : caches, entrées du registre.
- Licence : gratuite pour un particulier ou une petite structure (conditions
  de Visual Studio Community), ce qui correspond à PatateLand.

**Conséquences**
- Sur ton système : un logiciel de développement en plus, aucun effet sur
  Windows, sur tes jeux ni sur l'ancien launcher, dont le build Electron ne
  l'utilise pas.
- Sur le projet : la variante MSVC de Rust s'ajoute dans `.toolchain/`.
  `as.exe` et `dlltool.exe` (WinLibs) ne servent plus et peuvent être
  supprimés.

## Option 2 : xwin, bibliothèques portables dans `.toolchain`

`xwin` est un outil open source écrit en Rust. Il télécharge les
bibliothèques MSVC et le SDK Windows **depuis les serveurs officiels de
Microsoft** et les dépose dans un simple dossier. Pour le reste (éditeur de
liens, compilateur de ressources, compilateur C), il faut aussi un **LLVM
portable** : `lld-link`, `llvm-rc`, `clang-cl`.

**Avantages**
- **Rien sur le système** : tout reste dans
  `PatateLand-Launcher-Rust\.toolchain`, sans droits administrateur ni
  registre. Supprimer le dossier suffit à tout retirer.
- Même logique que ce qu'on a fait jusqu'ici.
- Version figée : pas de mise à jour automatique en arrière-plan.

**Inconvénients**
- **Non officiel pour Tauri sur Windows** : `xwin` sert surtout à compiler
  pour Windows depuis Linux ou macOS. Il faudra régler des variables
  d'environnement (bibliothèques, en-têtes, éditeur de liens, compilateur
  de ressources). Les dépendances qui appellent directement `cl.exe` ou
  MSBuild ne compileront pas.
- **Différent de la CI** : l'exe local et celui de la CI ne sont pas
  produits avec les mêmes outils. Un bug pourrait n'apparaître que d'un
  côté.
- Environ **2 à 3 Go** dans `.toolchain` (SDK + CRT + LLVM).
- Plus de temps passé sur l'outillage que sur le launcher, et des surprises
  possibles à chaque nouvelle dépendance.
- Licence : il faut accepter la même licence Microsoft que pour les Build
  Tools (`--accept-license`). Ces fichiers ne doivent jamais être mis dans
  git ni redistribués (`.toolchain/` est déjà ignoré).

**Conséquences**
- Sur ton système : aucune.
- Sur le projet : un script d'environnement plus complexe (`env.sh`), et une
  configuration Cargo spécifique à documenter.

## (Pour mémoire) Rester en GNU

Tauri peut parfois se compiler en GNU, en ajoutant `windres` depuis WinLibs.
Ce n'est ni testé ni supporté par Tauri, et c'est encore plus éloigné de la
CI. **Déconseillé.**

---

## Recommandation : option 1, Visual Studio Build Tools

Pour l'interface, la fiabilité compte plus que l'isolation des outils. On
veut que l'exe testé chez toi soit construit exactement comme celui que
recevront les joueurs. Les Build Tools n'ont aucun effet sur Windows, tes
jeux ou l'ancien launcher : c'est un outil de développement de plus,
désinstallable.

Si garder ton système strictement intact passe avant tout, l'option 2 est
faisable. Il faut alors accepter plus de réglages, et un léger écart avec la
CI.

## Décision : option 1 (validée le 20/11/2026)

Commande, à lancer **par toi** dans un PowerShell administrateur :

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools --exact --source winget --override "--passive --wait --norestart --nocache --add Microsoft.VisualStudio.Component.VC.Tools.x86.x64 --add Microsoft.VisualStudio.Component.Windows11SDK.26100"
```

| Composant | Rôle |
|---|---|
| Visual Studio Build Tools 2022 (socle + MSBuild) | Base obligatoire du produit, installée d'office |
| `VC.Tools.x86.x64` : compilateur et éditeur de liens MSVC x64/x86 | Compiler et lier Rust en MSVC, compiler le code C éventuel des dépendances |
| `Windows11SDK.26100` : SDK Windows 11 | Bibliothèques système Windows + `rc.exe`, l'outil qui intègre l'icône et le manifeste dans l'exe |

Pas d'éditeur Visual Studio, pas de composants « recommandés ». Environ
5 Go. `--passive` affiche la progression sans poser de questions ;
`--norestart` empêche tout redémarrage automatique ; `--nocache` ne garde
pas les fichiers d'installation.

Version 2022 plutôt que 2026 : c'est celle présente depuis longtemps sur les
machines Windows de GitHub Actions, la plus sûre pour que la compilation
locale soit identique à celle de l'installateur.

## Résultats après installation (20/11/2026)

**Installé par toi** : Visual Studio Build Tools 2022 17.14 (complet, pas
de redémarrage requis). Il comprend MSVC 14.44 (`cl.exe`, `link.exe`,
`dumpbin.exe`) et le SDK Windows 10.0.26100 (`rc.exe`), pour **3,3 Go** au
total (1,6 + 1,7). C'est moins que les 5 Go estimés.

**Ajouté dans le projet** (`.toolchain`, rien sur le système) : Rust
`stable-x86_64-pc-windows-msvc` 1.100.0, même version que la variante GNU.

| Vérification | Résultat |
|---|---|
| Compilation du projet en MSVC | ✅ 37 à 41 s, aucun avertissement |
| Tests automatiques | ✅ **41/41, identiques test par test à GNU** |
| Tests sur services et fichiers réels | ✅ Microsoft réel, site PatateLand en panne (compte conservé), `servers.dat` réel identique à l'octet |
| Lancement réel Forge 1.20.1 (instance Opti) | ✅ menu principal en 19,2 s, `servers.dat` injecté, RAM des réglages appliquée |
| Vitesse de vérification GNU / MSVC (cache chaud, 2 essais chacun) | Identique : 1,7-1,8 s un par un, 0,37-0,39 s en parallèle, 0,04 s avec l'index |

**Bibliothèque C intégrée (CRT statique).** Par défaut, un exe MSVC dépend
de `VCRUNTIME140.dll` (« Visual C++ Redistributable »), qui n'est pas
garanti chez les joueurs. Sans lui, le launcher ne démarrerait pas.
`.cargo/config.toml` intègre donc cette bibliothèque à l'exe, pour la cible
MSVC uniquement. C'est aussi ce que recommande Tauri. Vérifié avec
`dumpbin` : l'exe ne dépend plus que de DLL système de Windows, pour 0,1 Mo
de plus (7,3 Mo).

**Mesure à froid obtenue au passage.** Juste après l'installation, les
fichiers du jeu n'étaient plus dans le cache mémoire de Windows. La
vérification de 4 084 fichiers a pris **21,9 s avec la méthode de l'ancien
launcher, contre 0,04 s avec l'index**, qui n'a pas besoin de relire les
fichiers. C'est le cas d'un joueur qui lance le jeu après avoir allumé son
PC.

### Les outils GNU servent-ils encore ?

| Élément | Taille | Encore utile ? |
|---|---|---|
| Rust `stable-x86_64-pc-windows-gnu` | 845 Mo | C'est encore l'outil **par défaut** du projet : `cargo` sans précision compile en GNU. Plus nécessaire dès qu'on bascule le défaut sur MSVC |
| `.toolchain/binutils` (`as`, `dlltool` de WinLibs) | 69 Mo | Uniquement pour la cible GNU. Inutile en MSVC |
| `target/` (compilations GNU) | 734 Mo | Référence GNU (41 tests, `pl-cli.exe` utilisé jusqu'ici) |

Proposition :

1. **Maintenant** : passer l'outil par défaut du projet sur MSVC (réglage
   interne à `.toolchain`, réversible), et faire de `target-msvc` le dossier
   de compilation principal.
2. **Garder GNU encore un peu**, comme solution de secours, jusqu'à ce que
   l'application Tauri compile et se lance en MSVC.
3. **Ensuite seulement, et avec ton accord** : supprimer la variante GNU,
   `binutils` et `target/`, ce qui libère environ 1,6 Go.

### Bascule effectuée : MSVC par défaut (validée le 20/11/2026)

- `rustup default stable-x86_64-pc-windows-msvc`. Ce réglage concerne
  uniquement le Rust installé dans `.toolchain`, rien sur le système.
- `.cargo/config.toml` : les compilations vont dans **`target-msvc/`**.
  `target/` reste intact, avec la compilation GNU de secours.
- Les deux ont été vérifiées après la bascule : **41/41 tests en MSVC
  (défaut) et 41/41 en GNU**.
- Rien n'a été supprimé : la variante GNU, `binutils` et `target/` sont
  conservés jusqu'à ce que Tauri soit compilé, lancé et testé.

### Revenir à GNU

Ponctuellement, sans changer le défaut :

```bash
source env.sh
CARGO_TARGET_DIR=target cargo +stable-x86_64-pc-windows-gnu build --release
CARGO_TARGET_DIR=target cargo +stable-x86_64-pc-windows-gnu test --release --workspace
```

Définitivement :

```bash
source env.sh
rustup default stable-x86_64-pc-windows-gnu
# puis, dans .cargo/config.toml, remplacer target-dir = "target-msvc" par "target"
```

Pour revenir ensuite à MSVC : `rustup default stable-x86_64-pc-windows-msvc`
et `target-dir = "target-msvc"`.

## Après l'installation (procédure prévue)

1. Je te donne la commande exacte (`winget`, en administrateur) avec
   uniquement les composants nécessaires : compilateur MSVC x64 + SDK
   Windows 11, sans l'éditeur Visual Studio.
2. **C'est toi qui la lances.** Je n'ai pas les droits administrateur et je
   n'installe rien sans ton accord.
3. J'ajoute la variante MSVC de Rust dans `.toolchain/`, puis je vérifie que
   le moteur et ses 37 tests passent à l'identique.
4. Seulement ensuite : création de l'application Tauri, dans un dossier à
   part du projet Rust.
