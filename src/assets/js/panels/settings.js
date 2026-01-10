import { changePanel, accountSelect, database, Slider, config, setStatus, popup, appdata, setBackground } from '../utils.js'
const { ipcRenderer } = require('electron');
const os = require('os');

class Settings {
    static id = "settings";
    async init(config) {
        this.config = config;
        this.db = new database();
        
        // On initialise pas la RAM ici car l'onglet est caché (width = 0)
        this.ramInitialized = false; 

        this.navBTN()
        this.accounts()
        this.javaPath()
        this.resolution()
        this.launcher()
    }

    navBTN() {
        document.querySelector('.nav-box').addEventListener('click', e => {
            if (e.target.classList.contains('nav-settings-btn')) {
                let id = e.target.id

                if (id == 'save') {
                    return changePanel('home')
                }

                // Gestion visuelle des boutons
                let activeSettingsBTN = document.querySelector('.active-settings-BTN')
                if (activeSettingsBTN) activeSettingsBTN.classList.remove('active-settings-BTN');
                e.target.classList.add('active-settings-BTN');

                // Gestion visuelle des onglets
                let activeContainerSettings = document.querySelector('.active-container-settings')
                if (activeContainerSettings) activeContainerSettings.classList.remove('active-container-settings');
                
                let targetTab = document.querySelector(`#${id}-tab`);
                if(targetTab) {
                    targetTab.classList.add('active-container-settings');
                    
                    // CORRECTION RAM : On initialise le slider uniquement quand on ouvre l'onglet JAVA
                    if (id === 'java') {
                        setTimeout(() => {
                            this.ram();
                        }, 50); // Petit délai pour que le CSS (display:block) s'applique
                    }
                }
            }
        })
    }

    async ram() {
        if (this.ramInitialized) return;

        let sliderDiv = document.querySelector(".memory-slider");
        if (!sliderDiv || sliderDiv.offsetWidth === 0) return;

        this.ramInitialized = true;

        let config = await this.db.readData('configClient');
        let totalMem = Math.trunc(os.totalmem() / 1073741824 * 10) / 10;
        let freeMem = Math.trunc(os.freemem() / 1073741824 * 10) / 10;

        document.getElementById("total-ram").textContent = `${totalMem} Go`;
        document.getElementById("free-ram").textContent = `${freeMem} Go`;

        // Limite max du slider à 80% de la RAM totale
        sliderDiv.setAttribute("max", Math.trunc((80 * totalMem) / 100));

        let ram = config?.java_config?.java_memory ? {
            ramMin: config.java_config.java_memory.min,
            ramMax: config.java_config.java_memory.max
        } : { ramMin: "1", ramMax: "2" };

        let slider = new Slider(".memory-slider", parseFloat(ram.ramMin), parseFloat(ram.ramMax));

        let minSpan = document.querySelector(".slider-touch-left span");
        let maxSpan = document.querySelector(".slider-touch-right span");

        // --- CORRECTION : Fonction de nettoyage des valeurs ---
        const cleanValue = (val) => {
            let num = parseFloat(val.toFixed(1)); // Garde 1 décimale (ex: 1.5)
            if (num < 0) return 0; // Empêche le négatif
            return num;
        };

        // Affichage initial propre
        let initMin = cleanValue(parseFloat(ram.ramMin));
        let initMax = cleanValue(parseFloat(ram.ramMax));
        
        minSpan.innerText = `${initMin} Go`;
        maxSpan.innerText = `${initMax} Go`;
        minSpan.setAttribute("value", `${initMin} Go`);
        maxSpan.setAttribute("value", `${initMax} Go`);

        slider.on("change", async (min, max) => {
            let config = await this.db.readData('configClient');
            
            // Nettoyage en temps réel
            let cleanMin = cleanValue(min);
            let cleanMax = cleanValue(max);

            minSpan.innerText = `${cleanMin} Go`;
            maxSpan.innerText = `${cleanMax} Go`;
            
            minSpan.setAttribute("value", `${cleanMin} Go`);
            maxSpan.setAttribute("value", `${cleanMax} Go`);
            
            config.java_config.java_memory = { min: cleanMin, max: cleanMax };
            this.db.updateData('configClient', config);
        });
    }

    accounts() {
        document.querySelector('.accounts-list').addEventListener('click', async e => {
            let popupAccount = new popup()
            try {
                // On cible le parent .account si on clique sur l'icône
                let target = e.target.closest('.account'); 
                // Si on a cliqué sur le bouton supprimer (qui n'est pas dans .account mais à côté ou dedans selon structure)
                if(!target && e.target.classList.contains('delete-profile')) target = e.target; 

                if (target && target.classList.contains('account')) {
                    let id = target.id;
                    
                    if (id == 'add') {
                        document.querySelector('.cancel-home').style.display = 'inline'
                        return changePanel('login')
                    }
                    
                    popupAccount.openPopup({title: 'Connexion', content: 'Veuillez patienter...', color: 'var(--color)'})
                    let account = await this.db.readData('accounts', id);
                    let configClient = await this.setInstance(account);
                    await accountSelect(account);
                    configClient.account_selected = account.ID;
                    
                    // Mise à jour visuelle (optionnel si tu recharges le panel)
                    return await this.db.updateData('configClient', configClient);
                }

                if (e.target.classList.contains("delete-profile")) {
                    let id = e.target.id; 
                    popupAccount.openPopup({title: 'Suppression', content: 'Veuillez patienter...', color: 'var(--color)'})
                    await this.db.deleteData('accounts', id);
                    
                    // Suppression simple du DOM pour éviter de recharger tout le panel
                    let elementToDelete = document.getElementById(id); 
                    if(elementToDelete) elementToDelete.remove();
                    
                    let configClient = await this.db.readData('configClient');
                    // Si on supprime le compte actif, on bascule sur un autre ou login
                    if (configClient.account_selected == id) {
                        let allAccounts = await this.db.readAllData('accounts');
                        if(!allAccounts || Object.keys(allAccounts).length === 0) {
                            return changePanel('login');
                        } else {
                            // Prend le premier compte dispo
                            let newAccount = Object.values(allAccounts)[0];
                            configClient.account_selected = newAccount.ID
                            accountSelect(newAccount);
                            await this.db.updateData('configClient', configClient);
                        }
                    }
                }
            } catch (err) {
                console.error(err)
            } finally {
                popupAccount.closePopup();
            }
        })
    }

    async javaPath() {
        let javaPathText = document.querySelector(".java-path-txt")
        javaPathText.textContent = `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}/runtime`;

        let configClient = await this.db.readData('configClient')
        let javaPath = configClient?.java_config?.java_path || 'Utiliser la version par défaut';
        let javaPathInputTxt = document.querySelector(".java-path-input-text");
        let javaPathInputFile = document.querySelector(".java-path-input-file");
        javaPathInputTxt.value = javaPath;

        document.querySelector(".java-path-set").addEventListener("click", async () => {
            javaPathInputFile.value = '';
            javaPathInputFile.click();
            javaPathInputFile.onchange = async () => {
                if (javaPathInputFile.files[0]) {
                     let file = javaPathInputFile.files[0].path;
                     if (file.endsWith("java.exe") || file.endsWith("javaw.exe") || file.endsWith("java") || file.endsWith("javaw")) {
                        javaPathInputTxt.value = file;
                        let config = await this.db.readData('configClient');
                        config.java_config.java_path = file;
                        await this.db.updateData('configClient', config);
                     } else alert("Fichier java incorrect (doit être java.exe ou javaw.exe)");
                }
            }
        });

        document.querySelector(".java-path-reset").addEventListener("click", async () => {
            let configClient = await this.db.readData('configClient')
            javaPathInputTxt.value = 'Utiliser la version par défaut';
            configClient.java_config.java_path = null
            await this.db.updateData('configClient', configClient);
        });
    }

    async resolution() {
        let configClient = await this.db.readData('configClient')
        let resolution = configClient?.game_config?.screen_size || { width: 1920, height: 1080 };

        let width = document.querySelector(".width-size");
        let height = document.querySelector(".height-size");
        let resolutionReset = document.querySelector(".size-reset");

        width.value = resolution.width;
        height.value = resolution.height;

        width.addEventListener("change", async () => {
            let config = await this.db.readData('configClient');
            config.game_config.screen_size.width = width.value;
            await this.db.updateData('configClient', config);
        })

        height.addEventListener("change", async () => {
            let config = await this.db.readData('configClient');
            config.game_config.screen_size.height = height.value;
            await this.db.updateData('configClient', config);
        })
        
        resolutionReset.addEventListener("click", async () => {
            let config = await this.db.readData('configClient');
            config.game_config.screen_size = { width: '854', height: '480' };
            width.value = '854';
            height.value = '480';
            await this.db.updateData('configClient', config);
        })
    }

    async launcher() {
        let configClient = await this.db.readData('configClient');
        
        let maxDownloadFilesInput = document.querySelector(".max-files");
        let maxDownloadFilesReset = document.querySelector(".max-files-reset");
        maxDownloadFilesInput.value = configClient?.launcher_config?.download_multi || 5;

        maxDownloadFilesInput.addEventListener("change", async () => {
            let config = await this.db.readData('configClient');
            config.launcher_config.download_multi = maxDownloadFilesInput.value;
            await this.db.updateData('configClient', config);
        })
        
        maxDownloadFilesReset.addEventListener("click", async () => {
            let config = await this.db.readData('configClient');
            maxDownloadFilesInput.value = 5;
            config.launcher_config.download_multi = 5;
            await this.db.updateData('configClient', config);
        })

        // Theme
        let themeBox = document.querySelector(".theme-box");
        let theme = configClient?.launcher_config?.theme || "auto";
        
        document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active-theme'));
        if(theme == 'auto') document.querySelector('.theme-btn-auto').classList.add('active-theme');
        if(theme == 'dark') document.querySelector('.theme-btn-sombre').classList.add('active-theme');
        if(theme == 'light') document.querySelector('.theme-btn-clair').classList.add('active-theme');

        themeBox.addEventListener("click", async e => {
            if (e.target.classList.contains('theme-btn')) {
                document.querySelectorAll('.theme-btn').forEach(btn => btn.classList.remove('active-theme'));
                e.target.classList.add('active-theme');
                
                let newTheme = "auto";
                if(e.target.classList.contains('theme-btn-sombre')) newTheme = "dark";
                if(e.target.classList.contains('theme-btn-clair')) newTheme = "light";

                if(newTheme == "auto") setBackground();
                if(newTheme == "dark") setBackground(true);
                if(newTheme == "light") setBackground(false);

                let config = await this.db.readData('configClient');
                config.launcher_config.theme = newTheme;
                await this.db.updateData('configClient', config);
            }
        })

        // Close Action
        let closeBox = document.querySelector(".close-box");
        let closeAction = configClient?.launcher_config?.closeLauncher || "close-launcher";
        document.querySelectorAll('.close-btn').forEach(btn => btn.classList.remove('active-close'));
        if(closeAction == 'close-launcher') document.querySelector('.close-launcher').classList.add('active-close');
        if(closeAction == 'close-none') document.querySelector('.close-none').classList.add('active-close');
        if(closeAction == 'close-all') document.querySelector('.close-all').classList.add('active-close');

        closeBox.addEventListener("click", async e => {
             if (e.target.classList.contains('close-btn')) {
                document.querySelectorAll('.close-btn').forEach(btn => btn.classList.remove('active-close'));
                e.target.classList.add('active-close');
                
                let action = "close-launcher";
                if(e.target.classList.contains('close-none')) action = "close-none";
                if(e.target.classList.contains('close-all')) action = "close-all";

                let config = await this.db.readData('configClient');
                config.launcher_config.closeLauncher = action;
                await this.db.updateData('configClient', config);
             }
        })
    }
    
    async setInstance(auth) {
        let configClient = await this.db.readData('configClient')
        return configClient
    }
}
export default Settings;