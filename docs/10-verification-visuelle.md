# Vérification visuelle : comparaison avec l'ancien launcher

Date : 22/11/2026. Taille de référence : 1280 × 720, la taille par défaut des
deux launchers. Également contrôlé à la taille minimale, 980 × 552.

## Méthode

Les deux interfaces sont affichées dans Chrome **sans fenêtre** (headless),
avec un profil temporaire. Rien n'apparaît à l'écran et rien n'est modifié
dans l'ancien launcher, qui est seulement lu.

- **Ancien launcher** : son accueil et ses paramètres sont reconstitués avec
  ses propres fichiers CSS et le même HTML que celui produit par `home.js`.
  Voir `tools/visual/old-harness.html` et `h-settings.html`.
- **Nouveau launcher** : sa vraie interface, avec les commandes Rust
  remplacées par des données d'exemple (`tools/visual/stub.js`).
- **Positions et tailles** : mesurées avec `getBoundingClientRect` sur les
  deux interfaces.
- **Règles CSS** : chaque règle de l'ancien CSS est comparée à sa copie
  (`tools/visual/cssdiff.mjs`).

Pour relancer :

```powershell
cd tools\visual
node server.mjs          # dans un premier terminal
node drive.mjs s4-after.json   # captures dans run\visual\shots
```

## Problèmes signalés

### 1. Barre du bas collée en bas de la fenêtre

**Cause.** Le bandeau rouge « serveur injoignable » était placé entre la
barre de titre et le contenu, alors que le contenu gardait une hauteur fixe
(`100% - 36px`). La page débordait donc de la hauteur du bandeau, environ
30 px. Mesure : la barre allait de 630 à 730 px dans une fenêtre de 720 px.
Elle était coupée de 10 px et perdait sa marge de 20 px.

**Correction.**
- `<body>` est maintenant une colonne flexible : barre de titre, bandeau
  éventuel, puis le contenu dans la place restante.
- La barre du bas finit à 700 px, avec ou sans bandeau, comme dans l'ancien
  launcher.

### 2. Éléments trop opaques en revenant des paramètres

Trois causes, toutes reproduites puis corrigées.

1. **Nouvelle image de fond à chaque réglage enregistré.**
   `applyAppearance()` tirait une image au hasard à chaque changement de
   réglage. Mesure : un interrupteur basculé a fait passer le fond de
   l'image 1 à l'image 6. Pendant le chargement de la nouvelle image, les
   blocs translucides reposaient sur un fond uni et paraissaient opaques.
   - Ancien launcher : changement de fond au démarrage et au changement de
     thème seulement.
   - Correction : même comportement. Le fond ne change plus après un
     réglage (vérifié).
2. **Pages cachées avec `display: none`.** À chaque retour, le navigateur
   reconstruisait les calques de flou (`backdrop-filter`) et rejouait les
   animations d'entrée. Mesure : à 0 ms, l'encart MineStrator et le bandeau
   d'avis étaient invisibles, puis réapparaissaient.
   - Correction : les pages restent affichées les unes sur les autres et
     seule la page active est visible (`visibility`). Le changement de page
     est immédiat, et une page cachée n'a aucune transition (sinon les
     boutons du menu des paramètres restaient visibles 0,2 s).
3. **`will-change: backdrop-filter` manquant.** L'ancien launcher l'avait
   sur le bloc du serveur et la barre du bas, pour garder leur flou prêt.
   C'est rétabli.

**Vérifié** sur deux allers-retours Paramètres → Accueil → Paramètres →
Accueil, avec des captures à 0, 200, 800 et 900 ms. Le rendu est identique
d'une capture à l'autre et les opacités sont correctes dès la première.

### 2 bis. Fondus d'opacité et flou (signalé ensuite sur l'onglet Launcher)

**Cause.** Pendant **toute** animation d'opacité, Chromium (donc WebView2)
coupe le flou (`backdrop-filter`) des blocs concernés. C'est vrai que le
fondu porte sur leur conteneur ou sur le bloc lui-même. Les blocs paraissent
alors trop sombres ou trop opaques, puis « sautent » à leur vraie
transparence à la fin de l'animation.

**Mesure.** À 60 ms d'un changement d'onglet, aucun bloc n'était flouté. Le
fondu de 0,4 s entre pages, repris de l'ancien launcher, avait le même
défaut : il est donc abandonné.

**Correction.** Aucune animation d'opacité sur un élément flouté ni sur un
de ses conteneurs. Les animations concernées gardent leur mouvement, sans
fondu :
- onglets des paramètres : glissement ;
- carte de connexion : zoom ;
- bandeau d'avis et encart MineStrator : glissement ;
- panneau d'amis : glissement.

**Vérifié.** À 60 ms, les blocs sont déjà floutés et l'image est identique à
l'image finale.

**Règle à garder.** Ne jamais animer `opacity` sur un élément qui a un
`backdrop-filter`, ni sur un de ses conteneurs.

## Autres écarts trouvés et corrigés

| Élément | Ancien | Avant | Après |
|---|---|---|---|
| Orange | `#f27312`, la classe `global` remplaçait `#fd8e39` | `#fd8e39` | `#f27312` partout |
| Modèle de boîte des écrans recopiés | `content-box`, valeur par défaut | `border-box` partout | `content-box` pour paramètres, connexion, bandeau d'avis, encart partenaire et amis |
| Bandeau d'avis | 310 × 75 | 280 × 92 | 310 × 75 |
| Bloc du serveur | 810 px de large, y = 50, nom centré (1,2rem), flou 8 px | 768 px, y = 84, nom à gauche (1rem), flou 10 px | identique à l'ancien |
| Barre du bas | 1214 px, flou 20 px, ombre vers le haut, tête 64 px | 1152 px, flou 10 px, tête 56 px | identique à l'ancien |
| Carte d'actualité | pas de flou, en-tête teinté, titre centré, date jour/mois, texte 22 × 24 px | flou, titre à gauche, pas de date | identique à l'ancien |
| Commandes des actualités | sous la carte : flèches rondes (désactivées aux extrémités), points cliquables, barre de 12 s | dans la carte, petits boutons | identique à l'ancien |
| Titre « Actualités » | texte simple | gras avec ombre | texte simple |
| Voile du fond | noir à 50 %, dans les deux thèmes | 45 % (sombre), 15 % blanc (clair) | noir à 50 % |
| Paramètres : bouton ACCUEIL | juste sous la liste | collé en bas (`flex: 1` ajouté par erreur) | juste sous la liste |
| Paramètres : titres de section | toute la largeur | réduits au texte (`align-items` ajouté par erreur) | toute la largeur |
| Paramètres : nombres (résolution, téléchargements) | centrés | à gauche | centrés |

## Améliorations par rapport à l'ancien (volontaires)

- **Petite fenêtre avec bandeau** : la carte de connexion défile au lieu
  d'être coupée.
- **Recherche dans le panneau d'amis** : le champ occupe toute la ligne.
  Dans l'ancien launcher, il gardait sa largeur par défaut.
- **Conservé du nouveau launcher** :
  - barre de titre avec logo ;
  - pseudo à côté de la tête du joueur ;
  - bouton Amis ;
  - police Poppins dans les champs de saisie ;
  - mode léger (sans flou ni animations ; changement de page immédiat).

## Remarque non modifiée

Le bandeau d'avis recouvre le bouton « Découvrir MineStrator » de l'encart
partenaire. C'était déjà le cas dans l'ancien launcher : position identique,
à 130 px du bas. Ce comportement est laissé tel quel en attendant ton avis.
