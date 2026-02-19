/**
 * PatateLand Launcher - Log Window
 */

const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("path");
const os = require("os");

let dev = process.env.DEV_TOOL === 'open';
let logWindow = undefined;

function getWindow() {
    return logWindow;
}

function destroyWindow() {
    if (!logWindow) return;
    logWindow.close();
    logWindow = undefined;
}

function createWindow() {
    if (logWindow) return logWindow;

    // Récupère tous les écrans disponibles
    const displays = screen.getAllDisplays();
    // Si un second écran existe on l'utilise, sinon on prend le principal
    const targetDisplay = displays.length > 1 ? displays[1] : displays[0];
    const { x, y, width, height } = targetDisplay.workArea;

    // Centre la fenêtre sur l'écran cible
    const winWidth = 750;
    const winHeight = 480;
    const winX = Math.round(x + (width - winWidth) / 2);
    const winY = Math.round(y + (height - winHeight) / 2);

    logWindow = new BrowserWindow({
        title: "PatateLand - Console de jeu",
        width: winWidth,
        height: winHeight,
        x: winX,
        y: winY,
        minWidth: 600,
        minHeight: 380,
        resizable: true,
        icon: `./src/assets/images/icon/icon.${os.platform() === "win32" ? "ico" : "png"}`,
        frame: false,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true
        },
    });

    Menu.setApplicationMenu(null);
    logWindow.setMenuBarVisibility(false);
    logWindow.loadFile(path.join(`${app.getAppPath()}/src/log.html`));

    logWindow.once('ready-to-show', () => {
        if (logWindow) {
            if (dev) logWindow.webContents.openDevTools({ mode: 'detach' });
            logWindow.show();
        }
    });

    logWindow.on('closed', () => {
        logWindow = undefined;
    });

    return logWindow;
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};