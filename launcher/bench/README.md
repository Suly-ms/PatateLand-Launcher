# Protocole de mesure PatateBench

Objectif : comparer l'ancien launcher (Electron) et le nouveau (Rust) **dans
les mêmes conditions**, sans jamais toucher à ta session, tes comptes ou les
données de ton launcher actuel.

## Principe

- Tout se passe dans un utilisateur Windows dédié, **PatateBench**, qui a son
  propre `%APPDATA%` : l'ancien launcher y est installé « à neuf », comme chez
  un nouveau joueur.
- Un **compte AZauth de test** (pas le tien) sert pour les deux launchers.
- Mesures **seulement quand le site et le serveur de fichiers répondent**.
  Si `/config` répond mais pas le site, l'ancien launcher supprimerait le
  compte enregistré.
- Même PC, même connexion, aucun autre programme lourd ouvert. Chaque
  scénario est répété 5 fois et on garde la **médiane**.

## 1. Préparation (une seule fois, depuis ta session)

Dans un PowerShell **en administrateur**, depuis ce dossier :

```powershell
Set-ExecutionPolicy -Scope Process Bypass
.\setup-patatebench.ps1
```

Le script crée l'utilisateur, affiche son mot de passe une seule fois et
prépare `C:\PatateBench` (outils + `pl-cli.exe`).

## 2. Dans la session PatateBench

1. `Win+L` → se connecter en **PatateBench**.
2. Télécharger l'installateur officiel depuis les releases GitHub du
   launcher (la version que reçoivent les joueurs) et l'installer.
3. Ouvrir l'ancien launcher **une fois à la main** et connecter le compte de
   test, pour que l'écran d'accueil soit atteint aux mesures suivantes.
4. Ouvrir PowerShell dans `C:\PatateBench` :
   `Set-ExecutionPolicy -Scope Process Bypass`

## 3. Scénarios

Lancer chaque commande de mesure en parallèle du scénario (deux fenêtres
PowerShell). Les résultats vont dans `C:\PatateBench\results\`.

| # | Scénario | Ancien launcher | Nouveau moteur |
|---|---|---|---|
| S1 | Démarrage → accueil utilisable | `node run-old.mjs` | après l'étape Tauri |
| S2 | RAM et CPU au repos sur l'accueil (60 s) | `node run-old.mjs --idle 70 --keep-open` + `.\measure.ps1 -Process PatateLand -Seconds 60 -Label ancien-repos` | après l'étape Tauri |
| S3 | Installation complète de l'instance Opti (dossier vide) jusqu'au menu du jeu | supprimer `%APPDATA%\.patateland`, puis `node run-old.mjs --play --instance Opti --close-game` + `.\measure.ps1 -Process PatateLand -Seconds 600 -Label ancien-installation` | `.\pl-cli.exe --root C:\PatateBench\jeu-rust --report results\nouveau-s3.json launch --account <test> --instance Opti --exit-when-ready` + `.\measure.ps1 -Process pl-cli -Seconds 600 -Label nouveau-installation` |
| S4 | JOUER → processus Java, instance déjà installée | `node run-old.mjs --play --instance Opti --close-game` | même commande `pl-cli` qu'en S3, dossier conservé |
| S5 | RAM du launcher pendant que le jeu tourne (60 s) | `.\measure.ps1 -Process PatateLand -Seconds 60 -Label ancien-en-jeu` | `.\measure.ps1 -Process pl-cli -Seconds 60 -Label nouveau-en-jeu` |
| S6 | Taille | installateur + `%LOCALAPPDATA%\Programs\PatateLand` | `pl-cli.exe` (puis installateur Tauri) |

Pour S3, le cache disque de Windows est vide après un redémarrage de la
session : c'est la mesure « premier lancement de la journée ».

## 4. Après les mesures

- Copier `C:\PatateBench\results` dans `bench/results/` du projet.
- Remplir le tableau de `docs/03-...md` avec les médianes.
- Supprimer l'utilisateur : `.\remove-patatebench.ps1` (en administrateur,
  session PatateBench déconnectée).

## Limites connues

- Tant que l'interface Tauri n'existe pas, le nouveau launcher n'est mesuré
  que sur son moteur (S3 à S5). Le démarrage et la RAM au repos de
  l'interface (S1, S2) seront comparés après l'étape Tauri.
- `run-old.mjs` lit l'état de la page via le port de débogage de Chromium.
  Il n'a pas pu être testé contre l'ancien launcher réel : il refuse de
  tourner hors de la session PatateBench, et le serveur est en panne.
