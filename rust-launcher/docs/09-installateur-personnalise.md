# Installateur personnalisé : étude et proposition

Demande : une installation aux couleurs de PatateLand du début à la fin,
avec :
- un fond sombre, l'orange et le logo ;
- une barre de progression personnalisée ;
- le choix du dossier et des raccourcis ;
- un écran de fin avec « Lancer PatateLand ».

Contraintes :
- pas d'administrateur ;
- dossier, raccourcis et désinstallation indépendants de l'ancien launcher ;
- ne pas toucher à l'installateur actuel tant qu'il n'est pas remplacé ;
- ne pas alourdir le launcher.

**Rien n'a été développé.** Une maquette à valider :
[`docs/maquettes/installateur.html`](maquettes/installateur.html), à ouvrir
d'un double-clic dans ton navigateur. Elle est statique et n'installe rien.

## Les options possibles

| | A. Installateur NSIS de Tauri, personnalisé | B. **Installateur Tauri sur mesure** (recommandé) | C. Velopack |
|---|---|---|---|
| Principe | Garder NSIS : images, couleurs, pages `nsDialogs` | Petit programme d'installation fait avec Tauri, avec la même interface HTML/CSS que le launcher. Il copie le launcher, crée raccourcis et désinstallation | Outil d'installation et de mise à jour en Rust |
| Rendu | **Toujours l'assistant Windows**, avec un logo et des couleurs. Ne répond pas à la demande | **Interface 100 % PatateLand** : celle de la maquette | Un simple écran d'attente (image ou GIF), aucun choix possible |
| Dossier, raccourcis, options | Oui | Oui | Non (installation sans question) |
| Écran de fin « Jouer » | Basique | Oui | Non |
| Sans administrateur | Oui | Oui | Oui |
| Mise à jour automatique | À part | À faire nous-mêmes (même code que l'installation) | **Intégrée** (mises à jour différentielles) |
| Taille estimée | 9,5 Mo (actuel) | ≈ 14 à 17 Mo | ≈ 12 Mo |
| Effort | Faible | Moyen | Moyen |
| Effet sur le launcher | Aucun | Aucun : c'est un programme séparé, utilisé une seule fois | Aucun |

## Recommandation : B, avec NSIS gardé en secours

Un programme `PatateLand Rust - Installation.exe` :

- **Interface** : la même direction artistique que le launcher (mêmes
  couleurs, polices, fonds, logo). Animations discrètes, désactivées si
  Windows demande moins d'animations.
- **Contenu** : le launcher compressé à l'intérieur. Son empreinte SHA-256
  est vérifiée avant la copie, donc un fichier abîmé n'est jamais installé.
- **Ce qu'il fait**, uniquement pour l'utilisateur courant :
  - copie dans `%LOCALAPPDATA%\PatateLand Rust` (ou le dossier choisi) ;
  - raccourcis `PatateLand Rust.lnk` (bureau, menu Démarrer, au choix) ;
  - désinstallation dans `HKCU\…\Uninstall\PatateLand Rust`, visible dans
    « Applications installées » ;
  - options : lancement avec Windows, mode d'affichage normal ou léger.
- **Désinstallation** : le même programme, appelé depuis Windows, ne
  supprime que ses propres fichiers. Les données de jeu et les comptes sont
  gardés sauf choix contraire, et l'ancien launcher n'est jamais concerné.
  Avant toute suppression, le programme vérifie qu'il est bien dans son
  propre dossier.
- **WebView2 absent** (vieux Windows 10 seulement) : l'installateur ne peut
  pas afficher son interface HTML. Il installe alors WebView2 (programme
  officiel de Microsoft, intégré), puis continue. En secours, l'installateur
  NSIS actuel reste disponible.
- **Légèreté** : aucun impact sur le launcher. L'installateur ne tourne que
  quelques secondes, une seule fois.
- **Plus tard** : la mise à jour automatique réutilisera ce même code de
  copie et de vérification.

L'installateur NSIS actuel n'est pas modifié. Il reste disponible tant que
le nouvel installateur n'a pas été validé (installation et désinstallation
testées dans la session PatateBench).

À prévoir dans tous les cas avant diffusion : **signer** l'installateur
(certificat de signature de code). Sans signature, Windows SmartScreen
affiche un avertissement, quelle que soit la solution choisie.

## La maquette

Quatre écrans, dans une fenêtre sans bordure de 760 × 460 :

1. **Bienvenue** : logo, présentation, taille, « sans admin »,
   « indépendant de l'ancien launcher », bouton INSTALLER, lien
   « Personnaliser l'installation ».
2. **Options** : dossier (modifiable), raccourcis bureau / menu Démarrer,
   lancement avec Windows, mode d'affichage normal / léger.
3. **Installation** : barre orange lumineuse, étapes cochées une à une,
   astuce.
4. **Terminé** : coche animée, « Lancer PatateLand maintenant »,
   bouton JOUER.

Les boutons au-dessus de la fenêtre servent seulement à passer d'un écran à
l'autre dans la maquette.

## Réalisation (option B, validée le 21/11/2026)

Code : `crates/pl-setup`. Fabrication : `build-setup.ps1`, qui produit
`dist\PatateLand Rust - Installation.exe`. L'installateur NSIS
(`build-installer.ps1`) reste disponible en secours.

| | Taille |
|---|---|
| Programme d'installation (profil `setup`, optimisé pour la taille) | 4,1 Mo |
| Launcher : 21,8 Mo, compressé zstd niveau 19 | 8,0 Mo |
| Programme WebView2 de Microsoft (signature vérifiée à la fabrication) | 1,7 Mo |
| **Total à télécharger** | **13,8 Mo** |
| Sur le disque après installation (launcher et désinstallateur) | ≈ 26 Mo |

**Fonctionnement**
- Le launcher compressé est ajouté à la fin de l'exe, avec sa taille et son
  empreinte SHA-256. Il est vérifié pendant la copie : un fichier abîmé est
  refusé.
- Le désinstallateur est le même programme sans le launcher (4 Mo), lancé
  avec `--uninstall`. Il utilise des fenêtres Windows simples.
- Uniquement pour l'utilisateur courant : `HKCU` et dossiers personnels, sans
  administrateur.
- Le dossier choisi reçoit toujours un sous-dossier `PatateLand Rust`. La
  désinstallation ne supprime que ses deux fichiers, puis le dossier s'il est
  vide : jamais de suppression récursive.
- Les noms (entrée « Applications installées », raccourcis, démarrage
  automatique) sont ceux de l'installateur NSIS et du launcher. Une version
  installée par NSIS est reprise et mise à jour. L'écran affiche alors
  « Mise à jour ».
- Conservés : comptes, réglages, mondes, instances. L'option « Léger »
  modifie seulement `lite_mode` dans les réglages.
- Si WebView2 manque (Windows 10), l'installateur propose de lancer le
  programme officiel de Microsoft.
- Le launcher est ouvert : l'installateur le signale et propose de
  réessayer.

**Tests automatiques**
- lecture de l'overlay ;
- refus d'un launcher modifié ;
- installation dans un dossier temporaire ;
- mode léger qui conserve les autres réglages ;
- dossier dédié.

**Reste à tester à l'écran (avec accord)**
- installation réelle ;
- mise à jour ;
- désinstallation.

Idéalement dans la session PatateBench.
