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

        setInterval(async () => {
            let configClient = await this.db.readData('configClient')
            let instanceList = await config.getInstanceList()
            let options = instanceList.find(i => i.name == configClient.instance_select)

            if (options?.status) {
                await setStatus(options.status)
            }
        }, 5000)

        document.querySelector('.settings-btn').addEventListener('click', e => changePanel('settings'))

        document.querySelector('.player-head').addEventListener('click', () => { 
            changePanel('settings'); 
        });

    }


    async news() {
        let newsElement = document.querySelector('.news-list');
        let news = await config.getNews(this.config).then(res => res).catch(err => false);
        if (news) {
            if (!news.length) {
                let blockNews = document.createElement('div');
                const date = this.getdate(new Date())
                blockNews.classList.add('news-block');
                blockNews.innerHTML = `
                    <div class="news-header">
                        <img class="server-status-icon" src="assets/images/icon/icon.png">
                        <div class="header-text">
                            <div class="title">Aucune news n'est actuellement disponible.</div>
                        </div>
                        <div class="date">
                            <div class="day">${date.day}</div>
                            <div class="month">${date.month}</div>
                        </div>
                    </div>
                    <div class="news-content">
                        <div class="bbWrapper">
                            <p>Vous pourrez suivre ici toutes les news relatives au serveur.</p>
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
                            <img class="server-status-icon" src="assets/images/icon/icon.png">
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
            const date = this.getdate(new Date())
            blockNews.classList.add('news-block');
            blockNews.innerHTML = `
                <div class="news-header">
                        <img class="server-status-icon" src="assets/images/icon/icon.png">
                        <div class="header-text">
                            <div class="title">Error.</div>
                        </div>
                        <div class="date">
                            <div class="day">${date.day}</div>
                            <div class="month">${date.month}</div>
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
        let socials = document.querySelectorAll('.social-block, .social-sidebar-btn')

        socials.forEach(social => {
            social.addEventListener('click', e => {
                const url = e.currentTarget.dataset.url
                if (url) shell.openExternal(url)
            })
        });
    }

    async instancesSelect() {
        let configClient = await this.db.readData('configClient')
        let auth = await this.db.readData('accounts', configClient.account_selected)
        let instancesList = await config.getInstanceList()
        let instanceSelect = instancesList.find(i => i.name == configClient?.instance_select) ? configClient?.instance_select : null

        let instanceBTN = document.querySelector('.play-instance')
        let instancePopup = document.querySelector('.instance-popup')
        let instancesListPopup = document.querySelector('.instances-List')
        let instanceCloseBTN = document.querySelector('.close-popup')

        if (instancesList.length === 1) {
            document.querySelector('.instance-select').style.display = 'none'
            instanceBTN.style.paddingRight = '0'
        }

        if (!instanceSelect) {
            let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
            let configClient = await this.db.readData('configClient')
            configClient.instance_select = newInstanceSelect.name
            instanceSelect = newInstanceSelect.name
            await this.db.updateData('configClient', configClient)
        }

        for (let instance of instancesList) {
            if (instance.whitelistActive) {
                let whitelist = instance.whitelist.find(whitelist => whitelist == auth?.name)
                if (whitelist !== auth?.name) {
                    if (instance.name == newInstanceSelect) {
                        let newInstanceSelect = instancesList.find(i => i.whitelistActive == false)
                        let configClient = await this.db.readData('configClient')
                        configClient.instance_select = newInstanceSelect.name
                        instanceSelect = newInstanceSelect.name
                        setStatus(newInstanceSelect.status)
                        await this.db.updateData('configClient', configClient)
                    }
                }
            } else console.log(`Initializing instance ${instance.name}...`)
                if (instance.name == instanceSelect) {
                    setStatus(instance.status)
                    document.querySelector('.instance-select').textContent = instance.name
                }
        }

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
                            instancesListPopup.innerHTML += `
                                <div class="glow-container">
                                    <div id="${instance.name}" class="instance-elements active-instance">${instance.name}</div>
                                </div>`
                        } else {
                            instancesListPopup.innerHTML += `
                                <div id="${instance.name}" class="instance-elements">${instance.name}</div>`
                        }
                    }
                })
            } else {
                if (instance.name == instanceSelect) {
                    instancesListPopup.innerHTML += `
                        <div id="${instance.name}" class="instance-elements active-instance">${instance.name}</div>`
                } else {
                    instancesListPopup.innerHTML += `
                        <div id="${instance.name}" class="instance-elements">${instance.name}</div>`
                }
            }
        }

        instancesListPopup.onclick = async (e) => {
            const el = e.target.closest('.instance-elements')
            if (!el) return

            let selected = el.id
            console.log("INSTANCE CLICKED:", selected)

            let configClient = await this.db.readData('configClient')
            configClient.instance_select = selected
            await this.db.updateData('configClient', configClient)

            document.querySelector('.instance-select').textContent = selected

            let instance = instancesList.find(i => i.name == selected)
            if (instance?.status) setStatus(instance.status)

            instancePopup.style.display = 'none'
        }

        instancePopup.style.display = 'flex'
        }
        if (!e.target.closest('.instance-select')) {
            this.startGame()
        }
        })

        instanceCloseBTN.addEventListener('click', () => {
            instancePopup.style.display = 'none'
        })
            }

    async startGame() {
        let launch = new Launch()
        let configClient = await this.db.readData('configClient')
        let instance = await config.getInstanceList()
        let authenticator = await this.db.readData('accounts', configClient.account_selected)
        let options = instance.find(i => i.name == configClient.instance_select)

        let playInstanceBTN = document.querySelector('.play-instance')
        let infoStartingBOX = document.querySelector('.info-starting-game')
        let infoStarting = document.querySelector(".info-starting-game-text")
        let progressBar = document.querySelector('.progress-bar')
        let playTitle = document.querySelector('.play-title')

        let opt = {
            url: options.url,
            authenticator: authenticator,
            timeout: 10000,
            path: `${await appdata()}/${process.platform == 'darwin' ? this.config.dataDirectory : `.${this.config.dataDirectory}`}`,
            instance: options.name,
            version: options.loader.minecraft_version,
            detached: configClient.launcher_config.closeLauncher == "close-all" ? false : true,
            downloadFileMultiple: configClient.launcher_config.download_multi,
            intelEnabledMac: configClient.launcher_config.intelEnabledMac,

            loader: {
                type: options.loader.loader_type,
                build: options.loader.loader_version,
                enable: options.loader.loader_type == 'none' ? false : true
            },

            verify: options.verify,

            ignored: [...options.ignored],

            java: {
                path: configClient.java_config.java_path,
            },

            JVM_ARGS:  options.jvm_args ? options.jvm_args : [],
            GAME_ARGS: [
                ...(options.game_args ? options.game_args : []),
                ...(configClient.game_config.fullscreen ? ['--fullscreen'] : [])
            ],

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

        playInstanceBTN.style.display = "none"
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
            ipcRenderer.send('log-send', `Téléchargement : ${((progress / size) * 100).toFixed(0)}%`);
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

        let logWindowOpened = false;
        launch.on('data', (e) => {
            progressBar.style.display = "none"
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-hide")
            };
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load')
            infoStarting.innerHTML = `Demarrage en cours...`
            // Ouvre la fenêtre de logs une seule fois, seulement si activée dans les settings
            if (!logWindowOpened && configClient.game_config?.show_console !== false) {
                logWindowOpened = true;
                ipcRenderer.send('log-window-open');
                ipcRenderer.send('log-status', 'running');
            }
            const line = typeof e === 'string' ? e : JSON.stringify(e);
            ipcRenderer.send('log-send', line);
            console.log(e);
        })

        launch.on('close', code => {
            if (configClient.launcher_config.closeLauncher == 'close-launcher') {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            ipcRenderer.send('log-status', 'closed');
            infoStartingBOX.style.display = "none"
            playInstanceBTN.style.display = "flex"
            playTitle.style.display = "block"
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
            ipcRenderer.send('log-status', 'error');
            ipcRenderer.send('log-send', `ERREUR: ${JSON.stringify(err)}`);
            infoStartingBOX.style.display = "none"
            playInstanceBTN.style.display = "flex"
            playTitle.style.display = "block"
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