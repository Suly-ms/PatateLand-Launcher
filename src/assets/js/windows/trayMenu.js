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


const HTML_PATH = path.join(__dirname, '..', '..', '..', 'trayMenu.html');

let collapsedHeight = 260;

const EXPANDED_EXTRA_HEIGHT = 150;
const WINDOW_WIDTH = 240;

function getThemeBackgroundColor() {
    try {
        const store = new Store({ name: 'configClient' });
        const configClient = store.get('data');
        const theme = configClient?.launcher_config?.theme || 'auto';
        if (theme === 'light') return '#f2f2f2';
        return '#1b1d24'; 
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

    win.on('blur', () => {
        if (win && !win.isDestroyed()) {
            win.setOpacity(1);
            win.hide();
        }
    });

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

        x = Math.round(bounds.x + bounds.width - WINDOW_WIDTH);
        y = Math.round(bounds.y - height - 4);
    } else {
  
        x = workArea.x + workArea.width - WINDOW_WIDTH - 12;
        y = workArea.y + workArea.height - height - 12;
    }

    x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - WINDOW_WIDTH - 4));
    y = Math.max(workArea.y + 4, Math.min(y, workArea.y + workArea.height - height - 4));

    win.setPosition(x, y, false);
}

function toggleWindow(bounds) {
    if (!win || win.isDestroyed()) createWindow();
    if (!win) return;

    if (win.isVisible()) {
        win.hide();
        return;
    }

    win.setSize(WINDOW_WIDTH, collapsedHeight);
    positionWindow(bounds, collapsedHeight);
    win.show();
    win.focus();

    win.webContents.once('did-finish-load', () => {
        win.webContents.send('trayPopup-request-height', bounds);
    });
}

function hideWindow() {
    if (win && !win.isDestroyed()) win.hide();
}

function updateInstances(instances, running = []) {
    if (win && !win.isDestroyed()) {
        win.webContents.send('trayPopup-instances', { instances, running });
    }
}

ipcMain.on('trayPopup-toggle-submenu', (event, { open, itemCount }) => {
    if (!win || win.isDestroyed()) return;

    const extra = open ? Math.min(itemCount * 32, EXPANDED_EXTRA_HEIGHT) : 0;
    const newHeight = collapsedHeight + extra;
    const [currentX, currentY] = win.getPosition();
    const heightDiff = newHeight - win.getBounds().height;

    win.setBounds({
        x: currentX,
        y: currentY - heightDiff,
        width: WINDOW_WIDTH,
        height: newHeight
    });
});

ipcMain.on('trayPopup-content-height', (event, { height, bounds }) => {
    if (!win || win.isDestroyed()) return;

    collapsedHeight = Math.ceil(height) + 4;
    win.setSize(WINDOW_WIDTH, collapsedHeight);
    positionWindow(bounds, collapsedHeight);
});

module.exports = { createWindow, getWindow, toggleWindow, hideWindow, updateInstances };