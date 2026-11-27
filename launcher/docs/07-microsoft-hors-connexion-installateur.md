# Microsoft, jeu hors connexion, installateur (étape 4, suite)

Feu vert du 21/11/2026 :
- connexion Microsoft dans l'interface ;
- instances jouables hors connexion ;
- installateur indépendant de l'ancien launcher ;
- choix explicite entre affichage normal et léger.

Règle ajoutée : **aucune capture, aucune fenêtre au premier plan, aucun jeu
lancé sans ton accord**. Tout ce qui suit a été vérifié sans ouvrir de
fenêtre (compilation, tests automatiques, outil en ligne de commande).

## 1. Mode d'affichage : normal ou léger, au choix du joueur

Réglages → Launcher → « Mode d'affichage », avec deux choix expliqués :

| Mode | Rendu | Effets | RAM fenêtre ouverte (mesurée) |
|---|---|---|---|
| **Normal** | Carte graphique (processus graphique de WebView2) | Flou, animations | ≈ 230 Mo |
| **Léger** | Processeur (`--disable-gpu`), sans processus graphique WebView2 | Aucun | ≈ 120 Mo |

Le texte du réglage dit clairement que le mode léger utilise le processeur
pour l'affichage. Le changement est complet au prochain démarrage du
launcher : les options de WebView2 ne s'appliquent qu'à la création de la
fenêtre.

## 2. Jouer quand le serveur PatateLand est indisponible

### Fonctionnement

1. À chaque réponse du serveur, `/config` et la liste des instances sont
   enregistrées dans `remote-cache.json` (dossier du launcher).
2. Si le serveur ne répond pas, cette copie est utilisée. **Un bandeau
   l'indique** : « Serveur PatateLand injoignable : informations du
   <date> (copie enregistrée sur ce PC). Tu peux jouer aux instances déjà
   installées. »
3. Une instance **déjà synchronisée au moins une fois** reste jouable. Les
   autres sont grisées : « Pas encore installée sur ce PC : connexion au
   serveur nécessaire ».
4. Au lancement hors connexion, chaque étape qui a besoin d'internet a une
   solution de repli, signalée au joueur :
   - Java : le Java déjà installé est utilisé ;
   - Forge « latest » : la version la plus récente déjà installée est utilisée ;
   - manifest de l'instance : les fichiers présents sont utilisés, sans
     vérification auprès du serveur ;
   - Minecraft : la copie locale du fichier de version est utilisée (déjà
     le cas avant).
5. La copie d'un **autre** serveur n'est jamais utilisée.
6. Les comptes ne sont jamais perdus pendant une panne : ils passent en
   « non vérifié » (voir docs/03).

### Vérifications

| Test | Résultat |
|---|---|
| 4 tests automatiques : copie enregistrée puis utilisée en panne (503), format `/instances`, copie d'un autre serveur refusée, erreur claire sans copie | ✅ |
| Coupure totale simulée (faux serveur arrêté + Mojang et Forge bloqués), instance Extra déjà installée | ✅ instance prête, messages « Hors connexion : Java déjà installé utilisé », « fichiers de Extra non vérifiés auprès du serveur » |
| Coupure totale, instance jamais synchronisée | ✅ refusée avec un message expliquant qu'une première connexion est nécessaire |

Temps d'installation pendant la coupure simulée : 8,2 s, contre 0,7 s en
ligne. Mesure par étape : **environ 2 s par service contacté**. C'est le
délai que met Windows à refuser une connexion vers un port local fermé, donc
un effet de la simulation :
- si PatateLand est en panne alors qu'internet marche, il répond
  immédiatement par une erreur (503) ;
- sans internet du tout, la recherche d'adresse échoue immédiatement.

## 3. Connexion Microsoft

| Point | Mise en œuvre |
|---|---|
| Fenêtre de connexion | Page officielle `login.live.com`, dans une fenêtre dédiée. **Le mot de passe est saisi chez Microsoft, jamais dans le launcher** |
| Récupération du code | Le launcher intercepte la redirection finale (`oauth20_desktop.srf?code=…`) et ferme la fenêtre. La page n'est jamais affichée |
| Vie privée | Navigation privée : aucun cookie Microsoft conservé par le launcher |
| Isolation | La fenêtre Microsoft n'a **aucune permission** (les permissions ne visent que la fenêtre principale) : la page distante ne peut appeler aucune commande du launcher |
| `client_id` | Celui de `/config` s'il existe, sinon l'identifiant public utilisé par l'ancien launcher |
| Après connexion | Chaîne Xbox → XSTS → Minecraft déjà testée (6 tests sur faux serveur, 1 sur les vrais serveurs Microsoft), compte enregistré avec tokens chiffrés, jamais supprimé automatiquement |
| Autres méthodes | AZauth et hors-ligne inchangés. Les comptes existants de tous types restent utilisables |

**Reste à faire, avec ton accord** : une vraie connexion. Elle ouvre une
fenêtre et demande un compte Microsoft qui possède Minecraft.

## 4. Installateur

Fabriqué avec `cargo tauri build` (outil `tauri-cli` 2.12.6, compilé dans
`.toolchain`). Les outils NSIS téléchargés par Tauri sont rangés dans
`target-msvc/.tauri` grâce à `useLocalToolsDir` : **rien dans
`%LOCALAPPDATA%`** (vérifié).

| | Ancien launcher | Nouveau launcher |
|---|---|---|
| Fichier d'installation | `PatateLand-win-x64.exe`, **146 Mo** | `PatateLand Rust_0.1.0_x64-setup.exe`, **9,5 Mo** |
| Dossier d'installation | `%LOCALAPPDATA%\Programs\PatateLand` | `%LOCALAPPDATA%\PatateLand Rust` |
| Raccourcis (menu Démarrer, bureau) | `PatateLand.lnk` | `PatateLand Rust.lnk` |
| Désinstallation (registre) | clé `942ef986-…` « PatateLand 1.4.2 » | clé `PatateLand Rust` |
| Identifiant / données | `fr.patateland.launcher`, `%APPDATA%\PatateLand`, `.patateland` | `fr.patateland.launcher.rust`, `%APPDATA%\PatateLand-Rust`, `.patateland-rust` |
| Droits administrateur | non | non (`currentUser`) |
| WebView2 absent (vieux Windows 10) | sans objet | installateur WebView2 intégré (`embedBootstrapper`) |

Pourquoi le nom « PatateLand Rust » : Tauri nomme raccourcis, dossier et
clé de désinstallation d'après le nom du produit. Avec « PatateLand », le
nouvel installateur **aurait écrasé les raccourcis `PatateLand.lnk` de
l'ancien launcher**. Le titre de la fenêtre reste « PatateLand ». Le nom
pourra changer si tu décides un jour de remplacer l'ancien launcher.

La désinstallation ne supprime que les fichiers du nouveau launcher. Les
données de jeu (`.patateland-rust`) et les comptes (`PatateLand-Rust`) sont
conservés, et l'ancien launcher n'est jamais concerné.

**Pas encore testé en installation réelle** : installer modifie le PC
(dossier, raccourcis, registre). À faire avec ton accord, idéalement dans
la session PatateBench.

À prévoir avant une diffusion aux joueurs :
- signature de l'exe (certificat), pour éviter l'avertissement SmartScreen ;
- mise à jour automatique signée.

## 5. Mode développement (depuis Visual Studio Code)

Lancement sans fabriquer ni installer l'exécutable, avec rechargement
automatique :

```powershell
cd C:\Users\afgam\Desktop\PatateLand-Launcher-Rust
powershell -ExecutionPolicy Bypass -File .\dev.ps1                 # serveur de démonstration Selvania
powershell -ExecutionPolicy Bypass -File .\dev.ps1 -Server mock    # faux serveur local (Node.js)
```

- Modifier `crates/pl-app/ui` (HTML, CSS, JS) : la fenêtre se recharge.
- Modifier le code Rust : recompilation (**≈ 3 s mesurées** pour un fichier
  de l'application) puis relance.
- Données de test du projet (`run/game`, `run/data`), jamais celles de
  l'ancien launcher.
- Arrêt : **Ctrl+C** dans le terminal (le faux serveur est arrêté avec).

`-ExecutionPolicy Bypass` ne vaut que pour cette commande : la politique
de sécurité de Windows n'est pas modifiée.

Première compilation de la version de développement : 2 min 31 (déjà
faite). Une CSP de développement (`devCsp`) autorise le petit script de
rechargement automatique ; la version distribuée garde sa CSP stricte.

**Non testé par moi** : le mode développement ouvre une fenêtre, je ne l'ai
donc pas lancé sans ton accord.
