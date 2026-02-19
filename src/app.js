/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, ipcMain, nativeTheme, dialog, shell, Tray, Menu, nativeImage, Notification } = require('electron');
const { Microsoft } = require('minecraft-java-core');
const { autoUpdater } = require('electron-updater')
const notifier = require('node-notifier');

const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const UpdateWindow = require("./assets/js/windows/updateWindow.js");
const MainWindow = require("./assets/js/windows/mainWindow.js");
const LogWindow = require("./assets/js/windows/logWindow.js");

let dev = process.env.NODE_ENV === 'dev';

if (dev) {
    let appPath = path.resolve('./data/Launcher').replace(/\\/g, '/');
    let appdata = path.resolve('./data').replace(/\\/g, '/');
    if (!fs.existsSync(appPath)) fs.mkdirSync(appPath, { recursive: true });
    if (!fs.existsSync(appdata)) fs.mkdirSync(appdata, { recursive: true });
    app.setPath('userData', appPath);
    app.setPath('appData', appdata)
}

Store.initRenderer();

app.setName('PatateLand');
app.setAppUserModelId('fr.patateland.launcher');

app.whenReady().then(() => restoreAutoLaunch());

// Démarrage automatique avec Windows/macOS
function setAutoLaunch(enabled) {
    app.setLoginItemSettings({
        openAtLogin: enabled,
        name: 'PatateLand',
        path: process.execPath
    });
}

// Restaure l'auto-launch depuis la DB après une mise à jour
async function restoreAutoLaunch() {
    try {
        const Store = require('electron-store');
        const store = new Store({ name: 'configClient' });
        const configClient = store.get('data');
        if (configClient?.launcher_config?.auto_launch === true) {
            setAutoLaunch(true);
        }
    } catch(e) {}
}

// Helper notification Electron natif (son Windows fiable)
function sendNotification({ title, body, silent = false, onClick = null }) {
    if (!Notification.isSupported()) return;
    const notif = new Notification({
        title,
        body,
        icon: path.join(__dirname, 'assets/images/icon/icon.png'),
        silent
    });
    if (onClick) notif.on('click', onClick);
    notif.show();
}

// ===== SYSTEM TRAY =====
let tray = null;

function createTray() {
    if (tray) return;
    const iconPath = path.join(__dirname, 'assets/images/icon/icon.png');
    const icon = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 });
    tray = new Tray(icon);

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Ouvrir le launcher',
            click: () => {
                MainWindow.getWindow().show();
                MainWindow.getWindow().focus();
            }
        },
        { type: 'separator' },
        {
            label: 'Quitter',
            click: () => app.quit()
        }
    ]);

    tray.setToolTip('PatateLand Launcher');
    tray.setContextMenu(contextMenu);

    tray.on('double-click', () => {
        MainWindow.getWindow().show();
        MainWindow.getWindow().focus();
    });
}
// ===== FIN SYSTEM TRAY =====

if (!app.requestSingleInstanceLock()) app.quit();
else app.whenReady().then(() => {
    if (dev) {
        MainWindow.createWindow();
        createTray();
        scheduleUpdateCheck();
        return;
    }
    UpdateWindow.createWindow();
});

ipcMain.on('main-window-open', () => {
    MainWindow.createWindow();
    if (!tray) createTray();
    scheduleUpdateCheck();
})
ipcMain.on('main-window-dev-tools', () => MainWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('main-window-dev-tools-close', () => MainWindow.getWindow().webContents.closeDevTools())
ipcMain.on('main-window-close', () => MainWindow.destroyWindow())
ipcMain.on('main-window-reload', () => MainWindow.getWindow().reload())
ipcMain.on('main-window-progress', (event, options) => MainWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('main-window-progress-reset', () => MainWindow.getWindow().setProgressBar(-1))
ipcMain.on('main-window-progress-load', () => MainWindow.getWindow().setProgressBar(2))

let trayNotifShown = false;

ipcMain.on('main-window-minimize', () => {
    MainWindow.getWindow().hide();

    if (!trayNotifShown) {
        trayNotifShown = true;
        sendNotification({
            title: 'PatateLand Launcher',
            body: 'Le launcher tourne en arriere-plan. Cliquez ici ou double-cliquez sur l\'icone pour le rouvrir.',
            silent: false,
            onClick: () => {
                MainWindow.getWindow().show();
                MainWindow.getWindow().focus();
            }
        });
    }
})

ipcMain.on('update-window-close', () => UpdateWindow.destroyWindow())
ipcMain.on('update-window-dev-tools', () => UpdateWindow.getWindow().webContents.openDevTools({ mode: 'detach' }))
ipcMain.on('update-window-progress', (event, options) => UpdateWindow.getWindow().setProgressBar(options.progress / options.size))
ipcMain.on('update-window-progress-reset', () => UpdateWindow.getWindow().setProgressBar(-1))
ipcMain.on('update-window-progress-load', () => UpdateWindow.getWindow().setProgressBar(2))

ipcMain.handle('path-user-data', () => app.getPath('userData'))
ipcMain.handle('appData', e => app.getPath('appData'))

ipcMain.on('main-window-maximize', () => {
    if (MainWindow.getWindow().isMaximized()) {
        MainWindow.getWindow().unmaximize();
    } else {
        MainWindow.getWindow().maximize();
    }
})

ipcMain.on('main-window-hide', () => MainWindow.getWindow().hide())
ipcMain.on('main-window-show', () => MainWindow.getWindow().show())

// ===== AUTO LAUNCH =====
ipcMain.handle('get-auto-launch', () => {
    return app.getLoginItemSettings().openAtLogin;
});

ipcMain.on('set-auto-launch', (_, enabled) => {
    setAutoLaunch(enabled);
});
// ===== FIN AUTO LAUNCH =====

// ===== LOG WINDOW =====
ipcMain.on('log-window-open', () => LogWindow.createWindow())
ipcMain.on('log-window-close', () => LogWindow.destroyWindow())
ipcMain.on('log-window-minimize', () => LogWindow.getWindow()?.minimize())

ipcMain.on('log-send', (_, data) => {
    const win = LogWindow.getWindow();
    if (win) win.webContents.send('log-data', data);
})

ipcMain.on('log-status', (_, status) => {
    const win = LogWindow.getWindow();
    if (win) win.webContents.send('log-status', status);
})
// ===== FIN LOG WINDOW =====

ipcMain.handle('Microsoft-window', async (_, client_id) => {
    return await new Microsoft(client_id).getAuth();
})

ipcMain.handle('is-dark-theme', (_, theme) => {
    if (theme === 'dark') return true
    if (theme === 'light') return false
    return nativeTheme.shouldUseDarkColors;
})

// ===== RESOURCE PACKS & SHADERS =====

ipcMain.handle('dialog-open-resourcepack', async () => {
    const result = await dialog.showOpenDialog(MainWindow.getWindow(), {
        title: 'Selectionner un Resource Pack',
        filters: [{ name: 'Resource Pack', extensions: ['zip'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('dialog-open-shaderpack', async () => {
    const result = await dialog.showOpenDialog(MainWindow.getWindow(), {
        title: 'Selectionner un Shader',
        filters: [{ name: 'Shader Pack', extensions: ['zip'] }],
        properties: ['openFile']
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
});

ipcMain.handle('open-folder', (_, folderPath) => {
    shell.openPath(folderPath);
});

// ===== RCON =====
// ===== FIN RCON =====

// ===== FIN RESOURCE PACKS & SHADERS =====

app.on('window-all-closed', () => {
    // L'utilisateur quitte via le menu tray "Quitter"
});

autoUpdater.autoDownload = false;

// Vérification automatique toutes les 10 minutes
let isFirstUpdateCheck = true;

function scheduleUpdateCheck() {
    // Premier check silencieux au démarrage (pas de notif)
    autoUpdater.checkForUpdates().catch(() => {});

    setInterval(() => {
        isFirstUpdateCheck = false;
        autoUpdater.checkForUpdates().catch(() => {});
    }, 10 * 60 * 1000); // 10 minutes
}

ipcMain.handle('update-app', async () => {
    return await new Promise(async (resolve, reject) => {
        autoUpdater.checkForUpdates().then(res => {
            resolve(res);
        }).catch(error => {
            reject({
                error: true,
                message: error
            })
        })
    })
})

autoUpdater.on('update-available', (info) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('updateAvailable');

    // Pas de notif au premier check (démarrage du launcher = mise à jour en cours)
    if (isFirstUpdateCheck) return;

    sendNotification({
        title: 'PatateLand - Mise a jour disponible !',
        body: 'Une nouvelle version est disponible. Double-cliquez pour relancer et mettre à jour.',
        silent: false,
        onClick: () => {
            // Relance le launcher pour déclencher la mise à jour
            app.relaunch();
            app.exit(0);
        }
    });
});

ipcMain.on('start-update', () => {
    autoUpdater.downloadUpdate();
})

autoUpdater.on('update-not-available', () => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('update-not-available');
});

autoUpdater.on('update-downloaded', () => {
    autoUpdater.quitAndInstall();
});

autoUpdater.on('download-progress', (progress) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('download-progress', progress);
})

autoUpdater.on('error', (err) => {
    const updateWindow = UpdateWindow.getWindow();
    if (updateWindow) updateWindow.webContents.send('error', err);
});