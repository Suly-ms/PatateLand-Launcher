/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config, database, logger, changePanel, appdata, setStatus, pkg, popup } from '../utils.js'

const { Launch } = require('minecraft-java-core')
const { shell, ipcRenderer } = require('electron')

class Home {
    static id = "home";
    async init(config) {
        this.config = config;
        this.db = new database();
        this.news()
        this.socialLick()
        this.instancesSelect()
        document.querySelector('.settings-btn').addEventListener('click', e => {
             if (this.statusInterval) clearInterval(this.statusInterval);
             changePanel('settings')
        })
    }

    async news() {
        let newsElement = document.querySelector('.news-list');
        let news = await config.getNews().then(res => res).catch(err => false);
        if (news) {
            if (!news.length) {
                let blockNews = document.createElement('div');
                blockNews.classList.add('news-block');
                blockNews.innerHTML = `
                    <div class="news-header">
                        <img class="server-status-icon" src="assets/images/icon.png">
                        <div class="header-text">
                            <div class="title">Aucun news n'ai actuellement disponible.</div>
                        </div>
                        <div class="date">
                            <div class="day">1</div>
                            <div class="month">Janvier</div>
                        </div>
                    </div>
                    <div class="news-content">
                        <div class="bbWrapper">
                            <p>Vous pourrez suivre ici toutes les news relative au serveur.</p>
                        </div>
                    </div>`
                newsElement.appendChild(blockNews);
            } else {
                for (let News of news) {
                    let date = this.getdate(News.publish_date)
                    let blockNews = document.createElement('div');
                    blockNews.classList.add('news-block');
                    blockNews.innerHTML = `
                        <div class="news-header">
                            <img class="server-status-icon" src="assets/images/icon.png">
                            <div class="header-text">
                                <div class="title">${News.title}</div>
                            </div>
                            <div class="date">
                                <div class="day">${date.day}</div>
                                <div class="month">${date.month}</div>
                            </div>
                        </div>
                        <div class="news-content">
                            <div class="bbWrapper">
                                <p>${News.content.replace(/\n/g, '</br>')}</p>
                                <p class="news-author">Auteur - <span>${News.author}</span></p>
                            </div>
                        </div>`
                    newsElement.appendChild(blockNews);
                }
            }
        } else {
            let blockNews = document.createElement('div');
            blockNews.classList.add('news-block');
            blockNews.innerHTML = `
                <div class="news-header">
                        <img class="server-status-icon" src="assets/images/icon.png">
                        <div class="header-text">
                            <div class="title">Error.</div>
                        </div>
                        <div class="date">
                            <div class="day">1</div>
                            <div class="month">Janvier</div>
                        </div>
                    </div>
                    <div class="news-content">
                        <div class="bbWrapper">
                            <p>Impossible de contacter le serveur des news.</br>Merci de vérifier votre configuration.</p>
                        </div>
                    </div>`
            newsElement.appendChild(blockNews);
        }
    }

    socialLick() {
        let socials = document.querySelectorAll('.social-block')

        socials.forEach(social => {
            social.addEventListener('click', e => {
                shell.openExternal(e.target.dataset.url)
            })
        });
    }

    // Méthode de boucle pour le statut
    startStatusLoop(statusData) {
        if (this.statusInterval) clearInterval(this.statusInterval);
        setStatus(statusData);
        this.statusInterval = setInterval(() => {
            setStatus(statusData);
        }, 5000);
    }

    async instancesSelect() {
        let configClient = await this.db.readData('configClient')
        let auth = await this.db.readData('accounts', configClient.account_selected)
        let instancesList = await config.getInstanceList()
        let instanceSelect = instancesList.find(i => i.name == configClient?.instance_select) ? configClient?.instance_select : null

        let instanceBTN = document.querySelector('.play-instance')
        let instancePopup = document.querySelector('.instance-popup')
        let instancesListPopup = document.querySelector('.instances-List')
        
        // Element visuel du bouton sélecteur
        let selectorBtnElement = document.querySelector('.instance-select');

        if (instancesList.length === 1) {
            if(selectorBtnElement) selectorBtnElement.style.display = 'none';
            instanceBTN.style.justifyContent = 'center'; 
        }

        if (!instanceSelect) {
            let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
            let configClient = await this.db.readData('configClient')
            configClient.instance_select = newInstanceSelect.name
            instanceSelect = newInstanceSelect.name
            await this.db.updateData('configClient', configClient)
        }
        
        if(selectorBtnElement) selectorBtnElement.textContent = instanceSelect;

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == auth?.name)
                if (whitelist !== auth?.name) {
                    if (instance.name == instanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        let configClient = await this.db.readData('configClient')
                        configClient.instance_select = newInstanceSelect.name
                        instanceSelect = newInstanceSelect.name
                        this.startStatusLoop(newInstanceSelect.status)
                        await this.db.updateData('configClient', configClient)
                    }
                }
            } else console.log(`Initializing instance ${instance.name}...`)
            
            if (instance.name == instanceSelect) this.startStatusLoop(instance.status)
        }

        instancePopup.addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')

            if (e.target.classList.contains('instance-elements')) {
                let newInstanceSelect = e.target.id
                let activeInstanceSelect = document.querySelector('.active-instance')

                if (activeInstanceSelect) activeInstanceSelect.classList.toggle('active-instance');
                e.target.classList.add('active-instance');

                configClient.instance_select = newInstanceSelect
                await this.db.updateData('configClient', configClient)
                instanceSelect = instancesList.filter(i => i.name == newInstanceSelect)
                instancePopup.style.display = 'none'
                
                if(selectorBtnElement) selectorBtnElement.textContent = newInstanceSelect;

                let instance = await config.getInstanceList()
                let options = instance.find(i => i.name == configClient.instance_select)
                this.startStatusLoop(options.status)
            }
        })

        instanceBTN.addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')
            let instanceSelect = configClient.instance_select
            let auth = await this.db.readData('accounts', configClient.account_selected)

            if (e.target.closest('.instance-select')) {
                instancesListPopup.innerHTML = ''
                for (let instance of instancesList) {
                    if (instance.whitelistActive) {
                        instance.whitelist.map(whitelist => {
                            if (whitelist == auth?.name) {
                                if (instance.name == instanceSelect) {
                                    instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements active-instance">${instance.name}</div>`
                                } else {
                                    instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements">${instance.name}</div>`
                                }
                            }
                        })
                    } else {
                        if (instance.name == instanceSelect) {
                            instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements active-instance">${instance.name}</div>`
                        } else {
                            instancesListPopup.innerHTML += `<div id="${instance.name}" class="instance-elements">${instance.name}</div>`
                        }
                    }
                }
                instancePopup.style.display = 'flex'
            
            } else if (e.target.closest('.play-btn')) {
                this.startGame()
            }
        })
        
        // SUPPRESSION DE L'EVENT LISTENER DU BOUTON CLOSE
    }

    async startGame() {
        let launch = new Launch()
        let configClient = await this.db.readData('configClient')
        let instance = await config.getInstanceList()
        let authenticator = await this.db.readData('accounts', configClient.account_selected)
        let options = instance.find(i => i.name == configClient.instance_select)

        let playInstanceBTN = document.querySelector('.play-instance')
        let playBtnOnly = document.querySelector('.play-btn') // Le bouton seul
        let infoStartingBOX = document.querySelector('.info-starting-game')
        let infoStarting = document.querySelector(".info-starting-game-text")
        let progressBar = document.querySelector('.progress-bar')

        let opt = {
            url: options.url,
            authenticator: authenticator,
            timeout: 10000,
            path: `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`,
            instance: options.name,
            version: options.loadder.minecraft_version,
            detached: configClient.launcher_config.closeLauncher == "close-all" ? false : true,
            downloadFileMultiple: configClient.launcher_config.download_multi,
            intelEnabledMac: configClient.launcher_config.intelEnabledMac,

            loader: {
                type: options.loadder.loadder_type,
                build: options.loadder.loadder_version,
                enable: options.loadder.loadder_type == 'none' ? false : true
            },

            verify: options.verify,

            ignored: [...options.ignored],

            java: {
                path: configClient.java_config.java_path,
            },

            JVM_ARGS:  options.jvm_args ? options.jvm_args : [],
            GAME_ARGS: options.game_args ? options.game_args : [],

            screen: {
                width: configClient.game_config.screen_size.width,
                height: configClient.game_config.screen_size.height
            },

            memory: {
                min: `${configClient.java_config.java_memory.min * 1024}M`,
                max: `${configClient.java_config.java_memory.max * 1024}M`
            }
        }

        launch.Launch(opt);

        // On grise le bouton jouer au lieu de tout cacher
        if(playBtnOnly) {
            playBtnOnly.style.opacity = '0.5';
            playBtnOnly.style.pointerEvents = 'none';
            playBtnOnly.textContent = '...';
        }
        
        infoStartingBOX.style.display = "block"
        progressBar.style.display = "";
        ipcRenderer.send('main-window-progress-load')

        launch.on('extract', extract => {
            ipcRenderer.send('main-window-progress-load')
            console.log(extract);
        });

        launch.on('progress', (progress, size) => {
            infoStarting.innerHTML = `Téléchargement ${((progress / size) * 100).toFixed(0)}%`
            ipcRenderer.send('main-window-progress', { progress, size })
            progressBar.value = progress;
            progressBar.max = size;
        });

        launch.on('check', (progress, size) => {
            infoStarting.innerHTML = `Vérification ${((progress / size) * 100).toFixed(0)}%`
            ipcRenderer.send('main-window-progress', { progress, size })
            progressBar.value = progress;
            progressBar.max = size;
        });

        launch.on('estimated', (time) => {
            let hours = Math.floor(time / 3600);
            let minutes = Math.floor((time - hours * 3600) / 60);
            let seconds = Math.floor(time - hours * 3600 - minutes * 60);
            console.log(`${hours}h ${minutes}m ${seconds}s`);
        })

        launch.on('speed', (speed) => {
            console.log(`${(speed / 1067008).toFixed(2)} Mb/s`)
        })

        launch.on('patch', patch => {
            console.log(patch);
            ipcRenderer.send('main-window-progress-load')
            infoStarting.innerHTML = `Patch en cours...`
        });

        launch.on('data', (e) => {
            progressBar.style.display = "none"
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-hide")
            };
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load')
            infoStarting.innerHTML = `Demarrage en cours...`
            console.log(e);
        })

        launch.on('close', code => {
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            infoStartingBOX.style.display = "none"
            
            // Réactiver le bouton
            if(playBtnOnly) {
                playBtnOnly.style.opacity = '1';
                playBtnOnly.style.pointerEvents = 'auto';
                playBtnOnly.textContent = 'Jouer';
            }
            
            infoStarting.innerHTML = `Vérification`
            new logger(pkg.name, '#7289da');
            console.log('Close');
        });

        launch.on('error', err => {
            let popupError = new popup()

            popupError.openPopup({
                title: 'Erreur',
                content: err.error,
                color: 'red',
                options: true
            })

            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            infoStartingBOX.style.display = "none"
            
            // Réactiver le bouton en cas d'erreur
            if(playBtnOnly) {
                playBtnOnly.style.opacity = '1';
                playBtnOnly.style.pointerEvents = 'auto';
                playBtnOnly.textContent = 'Jouer';
            }
            
            infoStarting.innerHTML = `Vérification`
            new logger(pkg.name, '#7289da');
            console.log(err);
        });
    }

    getdate(e) {
        let date = new Date(e)
        let year = date.getFullYear()
        let month = date.getMonth() + 1
        let day = date.getDate()
        let allMonth = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre']
        return { year: year, month: allMonth[month - 1], day: day }
    }
}
export default Home;