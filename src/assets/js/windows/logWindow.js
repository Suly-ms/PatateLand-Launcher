/**
 * PatateLand Launcher - Log Window
 */

const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("path");
const os = require("os");

let dev = process.env.DEV_TOOL === 'open';
let logWindows = new Map();

function getWindow(id = 'default') {
    return logWindows.get(id);
}

function destroyWindow(id = 'default') {
    const win = logWindows.get(id);
    if (!win) return;
    win.close();
    logWindows.delete(id);
}

function createWindow(id = 'default', title = 'PatateLand - Console de jeu') {
    if (logWindows.has(id)) return logWindows.get(id);

    const displays = screen.getAllDisplays();

    const targetDisplay = displays.length > 1 ? displays[1] : displays[0];
    const { x, y, width, height } = targetDisplay.workArea;

    const winWidth = 750;
    const winHeight = 480;
    const offset = logWindows.size * 30;
    const winX = Math.round(x + (width - winWidth) / 2) + offset;
    const winY = Math.round(y + (height - winHeight) / 2) + offset;

    const win = new BrowserWindow({
        title,
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
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(`${app.getAppPath()}/src/log.html`));

    win.once('ready-to-show', () => {
        if (dev) win.webContents.openDevTools({ mode: 'detach' });
        win.show();
    });

    win.on('closed', () => {
        logWindows.delete(id);
    });

    logWindows.set(id, win);
    return win;
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};