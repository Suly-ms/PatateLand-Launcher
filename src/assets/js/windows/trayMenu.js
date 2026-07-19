/**
 * Fenêtre popup custom pour le clic sur l'icône du tray.
 * Remplace le menu natif Windows par une fenêtre stylée dans le thème du launcher
 * (même principe que G HUB / Discord / Overwolf).
 */
const { BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

let win = null;

// __dirname ici = src/assets/js/windows
// trayMenu.html est à la racine de src/, donc on remonte 3 niveaux :
// windows -> js -> assets -> src
const HTML_PATH = path.join(__dirname, '..', '..', '..', 'trayMenu.html');

// Hauteur par défaut avant que le contenu réel ne soit mesuré par le renderer
// (trayMenu.html envoie 'trayPopup-content-height' juste après son chargement,
// donc cette valeur ne sert que le temps d'un très court instant au premier affichage).
let collapsedHeight = 260;
// Hauteur max ajoutée quand le sous-menu "Jouer" est ouvert
const EXPANDED_EXTRA_HEIGHT = 150;
const WINDOW_WIDTH = 240;

function getThemeBackgroundColor() {
    try {
        const store = new Store({ name: 'configClient' });
        const configClient = store.get('data');
        const theme = configClient?.launcher_config?.theme || 'auto';
        if (theme === 'light') return '#f2f2f2';
        return '#1b1d24'; // dark ou auto -> on part sur le sombre par défaut
    } catch (e) {
        return '#1b1d24';
    }
}

function createWindow() {
    if (!fs.existsSync(HTML_PATH)) {
        console.error(`[TrayMenu] Fichier introuvable : ${HTML_PATH}`);
        return;
    }

    win = new BrowserWindow({
        width: WINDOW_WIDTH,
        height: collapsedHeight,
        show: false,
        frame: false,
        transparent: false,
        backgroundColor: getThemeBackgroundColor(),
        resizable: false,
        movable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    win.loadFile(HTML_PATH).catch(err => {
        console.error('[TrayMenu] Erreur de chargement du popup :', err);
    });

    // Se ferme dès qu'on clique ailleurs, comme un vrai menu contextuel
    win.on('blur', () => {
        if (win && !win.isDestroyed()) {
            win.setOpacity(1); // reset au cas où, évite un fondu résiduel
            win.hide();
        }
    });

    // Filet de sécurité : Echap ferme toujours le popup
    win.webContents.on('before-input-event', (event, input) => {
        if (input.key === 'Escape') {
            if (win && !win.isDestroyed()) win.hide();
        }
    });

    win.on('closed', () => {
        win = null;
    });
}

function getWindow() {
    return win;
}

function positionWindow(bounds, height) {
    if (!win) return;

    const display = bounds ? screen.getDisplayNearestPoint({ x: bounds.x, y: bounds.y }) : screen.getPrimaryDisplay();
    const workArea = display.workArea;

    let x, y;

    if (bounds && (bounds.width > 0 || bounds.x > 0)) {
        // Ancre le popup juste au-dessus de l'icône, aligné sur son bord droit
        // (comme Overwolf/G HUB), collé avec un petit espace.
        x = Math.round(bounds.x + bounds.width - WINDOW_WIDTH);
        y = Math.round(bounds.y - height - 4);
    } else {
        // Fallback si les bounds ne sont vraiment pas disponibles
        x = workArea.x + workArea.width - WINDOW_WIDTH - 12;
        y = workArea.y + workArea.height - height - 12;
    }

    x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - WINDOW_WIDTH - 4));
    y = Math.max(workArea.y + 4, Math.min(y, workArea.y + workArea.height - height - 4));

    win.setPosition(x, y, false);
}

function toggleWindow(bounds) {
    if (!win || win.isDestroyed()) createWindow();
    if (!win) return; // création échouée (fichier introuvable)

    if (win.isVisible()) {
        win.hide();
        return;
    }

    win.setSize(WINDOW_WIDTH, collapsedHeight);
    positionWindow(bounds, collapsedHeight);
    win.show();
    win.focus();

    // Une fois le contenu chargé, on redemande une mesure fraîche au cas où
    // le nombre d'items ait changé depuis la dernière ouverture (ex: instances
    // ajoutées/retirées), et on repositionne proprement.
    win.webContents.once('did-finish-load', () => {
        win.webContents.send('trayPopup-request-height', bounds);
    });
}

function hideWindow() {
    if (win && !win.isDestroyed()) win.hide();
}

function updateInstances(instances) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('trayPopup-instances', instances);
    }
}

// Le renderer (trayMenu.html) prévient quand le sous-menu "Jouer" s'ouvre/ferme,
// avec le nombre d'instances à afficher, pour agrandir/réduire la fenêtre en conséquence.
ipcMain.on('trayPopup-toggle-submenu', (event, { open, itemCount }) => {
    if (!win || win.isDestroyed()) return;

    const extra = open ? Math.min(itemCount * 32, EXPANDED_EXTRA_HEIGHT) : 0;
    const newHeight = collapsedHeight + extra;
    const [currentX, currentY] = win.getPosition();
    const heightDiff = newHeight - win.getBounds().height;

    // On agrandit vers le haut (le popup reste ancré en bas, comme un vrai menu contextuel)
    win.setBounds({
        x: currentX,
        y: currentY - heightDiff,
        width: WINDOW_WIDTH,
        height: newHeight
    });
});

// Le renderer mesure la vraie hauteur de son contenu (.tray-menu) au chargement
// et nous l'envoie ici, pour éviter tout écart entre la hauteur fixe supposée
// et le contenu réellement affiché (ce qui coupait "Quitter" en bas du popup).
ipcMain.on('trayPopup-content-height', (event, { height, bounds }) => {
    if (!win || win.isDestroyed()) return;

    collapsedHeight = Math.ceil(height) + 4; // petite marge de sécurité
    win.setSize(WINDOW_WIDTH, collapsedHeight);
    positionWindow(bounds, collapsedHeight);
});

module.exports = { createWindow, getWindow, toggleWindow, hideWindow, updateInstances };