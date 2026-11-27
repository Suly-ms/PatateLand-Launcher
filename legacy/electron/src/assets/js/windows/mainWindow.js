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

function createWindow(startMinimized = false) {
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

        frame: isMac,
        titleBarStyle: isMac ? 'hiddenInset' : 'default',
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            // BUG CORRIGÉ : par défaut, Chromium ralentit fortement les
            // timers JS (setInterval/setTimeout) d'une fenêtre qui n'est
            // pas au premier plan ou minimisée (économie de ressources).
            // Ça touchait directement le heartbeat, le sondage des messages
            // non lus et du chat (voir friends.js), qui tournent tous en
            // tâche de fond — d'où les notifs qui n'arrivaient qu'en
            // rouvrant/mettant la fenêtre au premier plan (ce qui "réveille"
            // les timers et déclenche un rechargement immédiat). Désactivé
            // ici pour que ces sondages tournent à leur cadence normale même
            // fenêtre minimisée/dans le tray.
            backgroundThrottling: false
        },
    });
    Menu.setApplicationMenu(null);
    mainWindow.setMenuBarVisibility(false);
    mainWindow.loadFile(
    path.join(app.getAppPath(), 'app', 'launcher.html'));
    // Sur Mac : la croix cache la fenêtre au lieu de la détruire
    // sauf si on force le quit (menu tray ou Cmd+Q)
    mainWindow.on('close', (e) => {
        if (process.platform === 'darwin' && !app.isQuitting) {
            e.preventDefault();
            mainWindow.hide();
        }
    });

    // ===== SIGNAL DE VISIBILITÉ VERS LE RENDERER =====
    // Le renderer (friends.js) a besoin de savoir si la fenêtre est
    // vraiment VISIBLE à l'écran ou cachée/minimisée dans le tray, pour
    // décider s'il faut envoyer une notification native pour un nouveau
    // message reçu dans une conversation restée "ouverte" (au sens de
    // l'état JS) mais invisible pour l'utilisateur.
    //
    // Écouter directement les événements natifs de la fenêtre (plutôt que
    // d'intercepter chaque canal IPC qui pourrait la cacher/montrer :
    // main-window-minimize, main-window-hide, main-window-show, clic sur
    // le tray...) capture TOUS les cas de façon fiable en un seul endroit,
    // y compris d'éventuels futurs chemins de code qu'on ajouterait plus
    // tard sans penser à les répercuter ici.
    const broadcastVisibility = () => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        const visible = mainWindow.isVisible() && !mainWindow.isMinimized();
        mainWindow.webContents.send('window-visibility-changed', visible);
    };

    ['show', 'hide', 'minimize', 'restore'].forEach(evt => mainWindow.on(evt, broadcastVisibility));
    // ===== FIN SIGNAL DE VISIBILITÉ =====

    mainWindow.once('ready-to-show', () => {
        if (mainWindow) {
            if (dev) mainWindow.webContents.openDevTools({ mode: 'detach' })
            mainWindow.show()
            // Démarrage au lancement de Windows + option "démarrer minimisé" :
            // on affiche quand même la fenêtre (pour qu'elle apparaisse dans la
            // barre des tâches) puis on la minimise aussitôt, plutôt que de ne
            // jamais l'afficher.
            if (startMinimized) mainWindow.minimize();
        }
    });
}

module.exports = {
    getWindow,
    createWindow,
    destroyWindow,
};