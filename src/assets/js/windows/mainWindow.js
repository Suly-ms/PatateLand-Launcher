/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, BrowserWindow, Menu } = require("electron");
const path = require("path");
const os = require("os");
let dev = process.env.DEV_TOOL === 'open';
let mainWindow = undefined;

function getWindow() {
    return mainWindow;
}

function destroyWindow() {
    if (!mainWindow) return;
    app.quit();
    mainWindow = undefined;
}

function createWindow() {
    destroyWindow();
    const isMac = os.platform() === 'darwin';
    mainWindow = new BrowserWindow({
        title: app.getName(),
        width: 1280,
        height: 720,
        minWidth: 980,
        minHeight: 552,
        resizable: true,
        icon: `./src/assets/images/icon/icon.${os.platform() === "win32" ? "ico" : "png"}`,
        // Sur Mac : on garde la barre native avec les boutons rouge/jaune/vert
        // Sur Windows/Linux : frame false avec notre propre barre custom
        frame: isMac,
        titleBarStyle: isMac ? 'hiddenInset' : 'default',
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true
        },
    });
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(path.join(`${app.getAppPath()}/src/launcher.html`));
    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            if (dev) mainWindow.webContents.openDevTools({ mode: 'detach' })
            mainWindow.show()
        }
    });
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};