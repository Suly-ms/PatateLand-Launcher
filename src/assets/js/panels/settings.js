/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

import { changePanel, accountSelect, database, Slider, config, setStatus, popup, appdata, setBackground } from '../utils.js'
const { ipcRenderer } = require('electron');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');

class Settings {
    static id = "settings";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.navBTN()
        this.accounts()
        this.jeu()
        this.launcher()
        this.resourcePacks()
        this.shaderPacks()
    }

    navBTN() {
        document.querySelector('.nav-box').addEventListener('click', e => {
            if (e.target.classList.contains('nav-settings-btn')) {
                let id = e.target.id

                let activeSettingsBTN = document.querySelector('.active-settings-BTN')
                let activeContainerSettings = document.querySelector('.active-container-settings')

                if (id == 'save') {
                    if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                    document.querySelector('#account').classList.add('active-settings-BTN');
                    if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                    document.querySelector(`#account-tab`).classList.add('active-container-settings');
                    return changePanel('home')
                }

                if (activeSettingsBTN) activeSettingsBTN.classList.toggle('active-settings-BTN');
                e.target.classList.add('active-settings-BTN');
                if (activeContainerSettings) activeContainerSettings.classList.toggle('active-container-settings');
                document.querySelector(`#${id}-tab`).classList.add('active-container-settings');

                // Le slider RAM doit s'initialiser APRES que le tab jeu soit visible
                // car il a besoin de la largeur du DOM pour calculer les positions
                if (id === 'jeu' && !this.sliderInitialized) {
                    this.initRamSlider();
                }
            }
        })
    }

    accounts() {
        document.querySelector('.accounts-list').addEventListener('click', async e => {
            let popupAccount = new popup()
            try {
                let id = e.target.id
                if (e.target.classList.contains('account')) {
                    popupAccount.openPopup({
                        title: 'Connexion',
                        content: 'Veuillez patienter...',
                        color: 'var(--color)'
                    })

                    if (id == 'add') {
                        document.querySelector('.cancel-home').style.display = 'inline'
                        return changePanel('login')
                    }

                    let account = await this.db.readData('accounts', id);
                    let configClient = await this.setInstance(account);
                    await accountSelect(account);
                    configClient.account_selected = account.ID;
                    return await this.db.updateData('configClient', configClient);
                }

                if (e.target.classList.contains("delete-profile")) {
                    popupAccount.openPopup({
                        title: 'Connexion',
                        content: 'Veuillez patienter...',
                        color: 'var(--color)'
                    })
                    await this.db.deleteData('accounts', id);
                    let deleteProfile = document.getElementById(`${id}`);
                    let accountListElement = document.querySelector('.accounts-list');
                    accountListElement.removeChild(deleteProfile);

                    if (accountListElement.children.length == 1) return changePanel('login');

                    let configClient = await this.db.readData('configClient');

                    if (configClient.account_selected == id) {
                        let allAccounts = await this.db.readAllData('accounts');
                        configClient.account_selected = allAccounts[0].ID
                        accountSelect(allAccounts[0]);
                        let newInstanceSelect = await this.setInstance(allAccounts[0]);
                        configClient.instance_select = newInstanceSelect.instance_select
                        return await this.db.updateData('configClient', configClient);
                    }
                }
            } catch (err) {
                console.error(err)
            } finally {
                popupAccount.closePopup();
            }
        })
    }

    async setInstance(auth) {
        let configClient = await this.db.readData('configClient')
        let instanceSelect = configClient.instance_select
        let instancesList = await config.getInstanceList()

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == auth.name)
                if (whitelist !== auth.name) {
                    if (instance.name == instanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        configClient.instance_select = newInstanceSelect.name
                        await setStatus(newInstanceSelect.status)
                    }
                }
            }
        }
        return configClient
    }

    async jeu() {
        let configClient = await this.db.readData('configClient');

        // ===== RAM - prépare les données, le slider s'init au clic sur l'onglet =====
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        document.getElementById("total-ram").textContent = `${totalMem} Go`;
        document.getElementById("free-ram").textContent = `${freeMem} Go`;

        let sliderDiv = document.querySelector(".memory-slider");
        sliderDiv.setAttribute("max", Math.trunc((80 * totalMem) / 100));

        if (!configClient.java_config) configClient.java_config = {};

        let ram = configClient?.java_config?.java_memory ? {
            ramMin: configClient.java_config.java_memory.min,
            ramMax: configClient.java_config.java_memory.max
        } : { ramMin: 2, ramMax: 8 };

        if (totalMem < ram.ramMin) {
            configClient.java_config.java_memory = { min: 2, max: 8 };
            await this.db.updateData('configClient', configClient);
            ram = { ramMin: 2, ramMax: 8 };
        }

        let maxAllowed = Math.trunc((80 * totalMem) / 100);
        if (ram.ramMax > maxAllowed) {
            ram.ramMax = maxAllowed;
            configClient.java_config.java_memory = { min: ram.ramMin, max: ram.ramMax };
            await this.db.updateData('configClient', configClient);
        }

        // Stocke la config RAM, le slider sera créé dans initRamSlider() au clic
        this.ramConfig = ram;
        this.sliderInitialized = false;

        // ===== RESOLUTION - charge les valeurs sauvegardées =====
        let resolution = configClient?.game_config?.screen_size || { width: 854, height: 480 };

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let resolutionReset = document.querySelector(".size-reset");

        width.value = resolution.width;
        height.value = resolution.height;

        width.addEventListener("change", async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.screen_size.width = width.value;
            await this.db.updateData('configClient', cfg);
        });

        height.addEventListener("change", async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.screen_size.height = height.value;
            await this.db.updateData('configClient', cfg);
        });

        resolutionReset.addEventListener("click", async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.screen_size = { width: '854', height: '480' };
            width.value = '854';
            height.value = '480';
            await this.db.updateData('configClient', cfg);
        });

        // ===== FULLSCREEN =====
        let fullscreenToggle = document.getElementById('fullscreen-toggle');
        let fullscreen = configClient?.game_config?.fullscreen || false;
        fullscreenToggle.checked = fullscreen;

        // Grise les inputs résolution selon l'état du toggle
        const updateResolutionState = (isFullscreen) => {
            width.disabled = isFullscreen;
            height.disabled = isFullscreen;
            resolutionReset.style.pointerEvents = isFullscreen ? 'none' : '';
            resolutionReset.style.opacity = isFullscreen ? '0.4' : '';
            width.style.opacity = isFullscreen ? '0.4' : '';
            height.style.opacity = isFullscreen ? '0.4' : '';
        };

        // Applique l'état au chargement
        updateResolutionState(fullscreen);

        fullscreenToggle.addEventListener('change', async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.fullscreen = fullscreenToggle.checked;
            await this.db.updateData('configClient', cfg);
            updateResolutionState(fullscreenToggle.checked);
        });

        // ===== CONSOLE DE JEU =====
        let consoleToggle = document.getElementById('console-toggle');
        let showConsole = configClient?.game_config?.show_console ?? true;
        consoleToggle.checked = showConsole;

        consoleToggle.addEventListener('change', async () => {
            let cfg = await this.db.readData('configClient');
            cfg.game_config.show_console = consoleToggle.checked;
            await this.db.updateData('configClient', cfg);
        });

        // ===== JAVA PATH =====
        let javaPathText = document.querySelector(".java-path-txt");
        javaPathText.textContent = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}/runtime`;

        let javaPath = configClient?.java_config?.java_path || 'Utiliser la version de java livre avec le launcher';
        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        javaPathInputTxt.value = javaPath;

        document.querySelector(".java-path-set").addEventListener("click", async () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
            await new Promise((resolve) => {
                let interval;
                interval = setInterval(() => {
                    if (javaPathInputFile.value != '') resolve(clearInterval(interval));
                }, 100);
            });
            if (javaPathInputFile.value.replace(".exe", '').endsWith("java") || javaPathInputFile.value.replace(".exe", '').endsWith("javaw")) {
                let cfg = await this.db.readData('configClient');
                let file = javaPathInputFile.files[0].path;
                javaPathInputTxt.value = file;
                cfg.java_config.java_path = file;
                await this.db.updateData('configClient', cfg);
            } else alert("Le nom du fichier doit être java ou javaw");
        });

        document.querySelector(".java-path-reset").addEventListener("click", async () => {
            let cfg = await this.db.readData('configClient');
            javaPathInputTxt.value = 'Utiliser la version de java livre avec le launcher';
            cfg.java_config.java_path = null;
            await this.db.updateData('configClient', cfg);
        });
    }

    initRamSlider() {
        if (this.sliderInitialized) return;

        let slider = new Slider(".memory-slider", parseFloat(this.ramConfig.ramMin), parseFloat(this.ramConfig.ramMax));

        slider.on("change", async (min, max) => {
            let config = await this.db.readData('configClient');
            if (!config.java_config) config.java_config = {};
            config.java_config.java_memory = { min: min, max: max };
            await this.db.updateData('configClient', config);
        });

        this.sliderInitialized = true;
    }


    async launcher() {
        let configClient = await this.db.readData('configClient');

        let maxDownloadFiles = configClient?.launcher_config?.download_multi || 5;
        let maxDownloadFilesInput = document.querySelector(".max-files");
        let maxDownloadFilesReset = document.querySelector(".max-files-reset");
        maxDownloadFilesInput.value = maxDownloadFiles;

        maxDownloadFilesInput.addEventListener("change", async () => {
            let configClient = await this.db.readData('configClient')
            configClient.launcher_config.download_multi = maxDownloadFilesInput.value;
            await this.db.updateData('configClient', configClient);
        })

        maxDownloadFilesReset.addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            maxDownloadFilesInput.value = 5
            configClient.launcher_config.download_multi = 5;
            await this.db.updateData('configClient', configClient);
        })

        let themeBox = document.querySelector(".theme-box");
        let theme = configClient?.launcher_config?.theme || "auto";

        if (theme == "auto") {
            document.querySelector('.theme-btn-auto').classList.add('active-theme');
        } else if (theme == "dark") {
            document.querySelector('.theme-btn-sombre').classList.add('active-theme');
        } else if (theme == "light") {
            document.querySelector('.theme-btn-clair').classList.add('active-theme');
        }

        themeBox.addEventListener("click", async e => {
            if (e.target.classList.contains('theme-btn')) {
                let activeTheme = document.querySelector('.active-theme');
                if (e.target.classList.contains('active-theme')) return
                activeTheme?.classList.remove('active-theme');

                if (e.target.classList.contains('theme-btn-auto')) {
                    setBackground();
                    theme = "auto";
                    e.target.classList.add('active-theme');
                } else if (e.target.classList.contains('theme-btn-sombre')) {
                    setBackground(true);
                    theme = "dark";
                    e.target.classList.add('active-theme');
                } else if (e.target.classList.contains('theme-btn-clair')) {
                    setBackground(false);
                    theme = "light";
                    e.target.classList.add('active-theme');
                }

                let configClient = await this.db.readData('configClient')
                configClient.launcher_config.theme = theme;
                await this.db.updateData('configClient', configClient);
            }
        })

        let closeBox = document.querySelector(".close-box");
        let closeLauncher = configClient?.launcher_config?.closeLauncher || "close-launcher";

        if (closeLauncher == "close-launcher") {
            document.querySelector('.close-launcher')?.classList.add('active-close');

        } else if (closeLauncher == "close-window") {
            document.querySelector('.close-window')?.classList.add('active-close');
        } else if (closeLauncher == "close-none") {
            document.querySelector('.close-none')?.classList.add('active-close');
        }

        closeBox.addEventListener("click", async e => {
            if (e.target.closest('.close-btn')) {
                const btn = e.target.closest('.close-btn');
                let activeClose = document.querySelector('.active-close');
                if (btn.classList.contains('active-close')) return;
                activeClose?.classList.remove('active-close');

                let configClient = await this.db.readData('configClient');

                if (btn.classList.contains('close-none')) {
                    btn.classList.add('active-close');
                    configClient.launcher_config.closeLauncher = "close-none";
                } else if (btn.classList.contains('close-launcher')) {
                    // Réduire dans le tray
                    btn.classList.add('active-close');
                    configClient.launcher_config.closeLauncher = "close-launcher";
                    configClient.game_config.tray_on_launch = true;
                } else if (btn.classList.contains('close-window')) {
                    btn.classList.add('active-close');
                    configClient.launcher_config.closeLauncher = "close-window";
                    configClient.game_config.tray_on_launch = false;
}
                await this.db.updateData('configClient', configClient);
            }
        })

        // ===== AUTO LAUNCH =====
        let autoLaunchToggle = document.getElementById('autolaunch-toggle');
        if (process.platform === 'linux') {
            // Non supporté sur Linux, on cache le toggle
            autoLaunchToggle.closest('.settings-elements-box')?.previousElementSibling?.remove();
            autoLaunchToggle.closest('.settings-elements-box')?.remove();
        } else {
            // Priorité à la valeur en DB (survive aux mises à jour)
            let cfgForAutoLaunch = await this.db.readData('configClient');
            let currentAutoLaunch = cfgForAutoLaunch?.launcher_config?.auto_launch ?? await ipcRenderer.invoke('get-auto-launch');
            autoLaunchToggle.checked = currentAutoLaunch;
            autoLaunchToggle.addEventListener('change', async () => {
                ipcRenderer.send('set-auto-launch', autoLaunchToggle.checked);
                // Sauvegarder dans la DB pour survivre aux mises à jour
                let cfg = await this.db.readData('configClient');
                cfg.launcher_config.auto_launch = autoLaunchToggle.checked;
                await this.db.updateData('configClient', cfg);
            });
        }
        // ===== FIN AUTO LAUNCH =====
    }
    // ===== RESOURCE PACKS =====
    async resourcePacks() {
        const appdataPath = await appdata();
        const dataDir = process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`;

        const getRpFolder = async () => {
            const configClient = await this.db.readData('configClient');
            const instanceName = configClient.instance_select;
            const folder = path.join(appdataPath, dataDir, 'instances', instanceName, 'resourcepacks');
            if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
            return folder;
        };

        this.rpFolder = await getRpFolder();

        document.querySelector('#resourcepacks').addEventListener('click', async () => {
            this.rpFolder = await getRpFolder();
            this.loadResourcePacksList();
        });

        document.querySelector('.rp-add-btn').addEventListener('click', async () => {
            const filePath = await ipcRenderer.invoke('dialog-open-resourcepack');
            if (!filePath) return;
            const dest = path.join(this.rpFolder, path.basename(filePath));
            try {
                fs.copyFileSync(filePath, dest);
                this.loadResourcePacksList();
            } catch (err) {
                console.error('Erreur lors de la copie du resource pack :', err);
                alert('Impossible de copier le resource pack.');
            }
        });

        document.querySelector('.rp-open-folder-btn').addEventListener('click', () => {
            ipcRenderer.invoke('open-folder', this.rpFolder);
        });
    }

    loadResourcePacksList() {
        const list = document.querySelector('.resourcepacks-list');
        list.innerHTML = '';
        let files;
        try {
            files = fs.readdirSync(this.rpFolder).filter(f => f.endsWith('.zip') || fs.statSync(path.join(this.rpFolder, f)).isDirectory());
        } catch { files = []; }

        if (files.length === 0) {
            list.innerHTML = '<div class="rp-empty-msg">Aucun resource pack installé.</div>';
            return;
        }
        files.forEach(file => {
            const item = document.createElement('div');
            item.classList.add('rp-item');
            item.innerHTML = `<div class="rp-item-name">${file}</div><div class="rp-item-delete rp-delete-btn" data-file="${file}">Supprimer</div>`;
            list.appendChild(item);
        });
        list.querySelectorAll('.rp-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const fileName = e.target.getAttribute('data-file');
                const filePath = path.join(this.rpFolder, fileName);
                try {
                    if (fs.statSync(filePath).isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
                    else fs.unlinkSync(filePath);
                    this.loadResourcePacksList();
                } catch (err) { alert('Impossible de supprimer le resource pack.'); }
            });
        });
    }
    // ===== FIN RESOURCE PACKS =====

    // ===== SHADER PACKS =====
    async shaderPacks() {
        const appdataPath = await appdata();
        const dataDir = process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`;

        const getSpFolder = async () => {
            const configClient = await this.db.readData('configClient');
            const instanceName = configClient.instance_select;
            const folder = path.join(appdataPath, dataDir, 'instances', instanceName, 'shaderpacks');
            if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true });
            return folder;
        };

        this.spFolder = await getSpFolder();

        document.querySelector('#shaderpacks').addEventListener('click', async () => {
            this.spFolder = await getSpFolder();
            this.loadShaderPacksList();
        });

        document.querySelector('.sp-add-btn').addEventListener('click', async () => {
            const filePath = await ipcRenderer.invoke('dialog-open-shaderpack');
            if (!filePath) return;
            const dest = path.join(this.spFolder, path.basename(filePath));
            try {
                fs.copyFileSync(filePath, dest);
                this.loadShaderPacksList();
            } catch (err) { alert('Impossible de copier le shader.'); }
        });

        document.querySelector('.sp-open-folder-btn').addEventListener('click', () => {
            ipcRenderer.invoke('open-folder', this.spFolder);
        });
    }

    loadShaderPacksList() {
        const list = document.querySelector('.shaderpacks-list');
        list.innerHTML = '';
        let files;
        try {
            files = fs.readdirSync(this.spFolder).filter(f => f.endsWith('.zip') || fs.statSync(path.join(this.spFolder, f)).isDirectory());
        } catch { files = []; }

        if (files.length === 0) {
            list.innerHTML = '<div class="sp-empty-msg">Aucun shader installé.</div>';
            return;
        }
        files.forEach(file => {
            const item = document.createElement('div');
            item.classList.add('rp-item');
            item.innerHTML = `<div class="rp-item-name">${file}</div><div class="sp-delete-btn" data-file="${file}">Supprimer</div>`;
            list.appendChild(item);
        });
        list.querySelectorAll('.sp-delete-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const fileName = e.target.getAttribute('data-file');
                const filePath = path.join(this.spFolder, fileName);
                try {
                    if (fs.statSync(filePath).isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
                    else fs.unlinkSync(filePath);
                    this.loadShaderPacksList();
                } catch (err) { alert('Impossible de supprimer le shader.'); }
            });
        });
    }
    // ===== FIN SHADER PACKS =====
}
export default Settings;