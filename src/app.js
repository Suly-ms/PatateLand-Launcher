/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const { app, ipcMain, nativeTheme, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const { Microsoft } = require('minecraft-java-core');
const { autoUpdater } = require('electron-updater')
const notifier = require('node-notifier');

const path = require('path');
const fs = require('fs');
const Store = require('electron-store');

const UpdateWindow = require("./assets/js/windows/updateWindow.js");
const MainWindow = require("./assets/js/windows/mainWindow.js");

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

// Helper notification via node-notifier (petit icone style Lunar Client)
function sendNotification({ title, body, silent = true, onClick = null }) {
    notifier.notify({
        title,
        message: body,
        icon: path.join(__dirname, 'assets/images/icon/icon.png'),
        appID: 'fr.patateland.launcher',
        sound: !silent
    }, (err, response) => {
        if (onClick && response === 'activate') onClick();
    });
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
        return;
    }
    UpdateWindow.createWindow();
});

ipcMain.on('main-window-open', () => {
    MainWindow.createWindow();
    if (!tray) createTray();
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
            silent: true,
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

// ===== FIN RESOURCE PACKS & SHADERS =====

app.on('window-all-closed', () => {
    // L'utilisateur quitte via le menu tray "Quitter"
});

autoUpdater.autoDownload = false;

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

    sendNotification({
        title: 'PatateLand - Mise a jour disponible !',
        body: 'Une nouvelle version est disponible. Le launcher va se mettre a jour automatiquement.',
        silent: false,
        onClick: () => {
            const updateWindow = UpdateWindow.getWindow();
            if (updateWindow) {
                updateWindow.show();
                updateWindow.focus();
            }
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