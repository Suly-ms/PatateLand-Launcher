/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config as configModule, database, logger, changePanel, appdata, setStatus, pkg, popup } from '../utils.js'

const { Launch } = require('minecraft-java-core')
const { shell, ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')

// ===== MINI WRITER NBT (sans dépendance externe) =====
// prismarine-nbt a été abandonné ici : sa dépendance interne "ajv" utilise
// eval/new Function pour compiler des schémas, ce qui viole la CSP du
// renderer Electron (script-src 'self', sans 'unsafe-eval') et provoque un
// écran blanc au chargement. La structure qu'on écrit (servers.dat) étant
// très simple, on l'encode ici à la main en NBT big-endian non compressé
// (format natif attendu par Minecraft pour servers.dat).
function nbtWriteString(str) {
    const strBuf = Buffer.from(str, 'utf8')
    const buf = Buffer.alloc(2 + strBuf.length)
    buf.writeUInt16BE(strBuf.length, 0)
    strBuf.copy(buf, 2)
    return buf
}

function nbtWriteNamedTag(type, name, payloadBuf) {
    const nameBuf = Buffer.from(name, 'utf8')
    const header = Buffer.alloc(3 + nameBuf.length)
    header.writeUInt8(type, 0)
    header.writeUInt16BE(nameBuf.length, 1)
    nameBuf.copy(header, 3)
    return Buffer.concat([header, payloadBuf])
}

function buildServersDatBuffer(serverInfo) {
    const TAG_End = 0
    const TAG_Byte = 1
    const TAG_String = 8
    const TAG_List = 9
    const TAG_Compound = 10

    // Payload du compound représentant UN serveur (contenu de la liste)
    const serverCompoundPayload = Buffer.concat([
        nbtWriteNamedTag(TAG_String, 'name', nbtWriteString(serverInfo.name)),
        nbtWriteNamedTag(TAG_String, 'ip', nbtWriteString(serverInfo.ip)),
        nbtWriteNamedTag(TAG_Byte, 'acceptTextures', Buffer.from([1])),
        Buffer.from([TAG_End])
    ])

    const countBuf = Buffer.alloc(4)
    countBuf.writeInt32BE(1, 0) // un seul serveur dans la liste

    const listPayload = Buffer.concat([
        Buffer.from([TAG_Compound]), // type des éléments de la liste
        countBuf,
        serverCompoundPayload
    ])

    const rootPayload = Buffer.concat([
        nbtWriteNamedTag(TAG_List, 'servers', listPayload),
        Buffer.from([TAG_End])
    ])

    return nbtWriteNamedTag(TAG_Compound, '', rootPayload)
}
// ===== FIN mini writer NBT =====

// Descriptions affichées via l'icône "?" pour chaque instance.
// Les clés doivent correspondre exactement au champ "name" de l'instance.
const instanceDescriptions = {
    "Event": "Instance dédiée aux événements spéciaux et temporaires.",
    "Extra": "Instance avec des mods rendant le jeux plus beau et plus gourmant.",
    "Opti": "Instance optimisée pour de meilleures performances, idéale pour les configurations modestes."
}

const activeLaunches = new Map();

function notifyTrayRunning() {
    ipcRenderer.send('update-tray-running', Array.from(activeLaunches.keys()));
}

// ===== INJECTION AUTO DU SERVEUR PAR DÉFAUT =====
// Crée servers.dat avec le serveur de l'instance UNIQUEMENT si le fichier
// n'existe pas encore (donc au tout premier lancement de l'instance chez
// le joueur). Si servers.dat existe déjà (le joueur a peut-être ajouté ses
// propres serveurs, ou a déjà notre serveur par défaut), on ne touche à
// RIEN. servers.dat doit rester dans la liste "ignored" de l'instance
// (déjà le cas dans instances.php) pour que le système de vérification du
// launcher ne l'écrase jamais après ce premier lancement.
async function ensureDefaultServer(gameDir, serverInfo) {
    const serversPath = path.join(gameDir, 'servers.dat')

    if (fs.existsSync(serversPath)) return

    try {
        const buffer = buildServersDatBuffer(serverInfo)
        fs.mkdirSync(gameDir, { recursive: true })
        fs.writeFileSync(serversPath, buffer)
        console.log(`servers.dat créé automatiquement pour ${gameDir}`)
    } catch (err) {
        console.error('Erreur lors de la création automatique de servers.dat :', err)
    }
}
// ===== FIN injection serveur =====

class Home {
    static id = "home";

    async init(config) {
        this.config = config;
        this.db = new database();

        this.activeLaunches = activeLaunches;

        this.news()
        this.socialLick()
        this.instancesSelect()

        const db = this.db;
        setInterval(async () => {
            try {
                let configClient = await db.readData('configClient')
                let instanceList = await configModule.getInstanceList()
                let options = instanceList.find(i => i.name == configClient.instance_select)
                if (options?.status) await setStatus(options.status)
            } catch(e) { console.log("INTERVAL ERR:", e.message) }
        }, 15000)

        // Rafraîchissement automatique des news toutes les 5 minutes
        setInterval(() => {
            this.news();
        }, 3 * 60 * 1000);

        document.querySelector('.settings-btn').addEventListener('click', e => changePanel('settings'))

        document.querySelector('.player-head').addEventListener('click', () => {
            if (typeof this.config.online === 'string') {
                shell.openExternal(`${this.config.online}/profile`);
            } else {
                changePanel('settings');
            }
        });

        // ===== Actions déclenchées depuis le menu contextuel du tray =====
        // (voir app.js : clic droit sur l'icône dans la barre des tâches)
        ipcRenderer.on('tray-launch-instance', async (_, instanceName) => {
            this.startGame(instanceName)
        })

        ipcRenderer.on('tray-open-settings', () => {
            changePanel('settings')
        })

        ipcRenderer.on('tray-logout', async () => {
            let configClient = await this.db.readData('configClient')
            configClient.account_selected = null
            await this.db.updateData('configClient', configClient)
            location.reload()
        })
        // ===== FIN actions tray =====

    }

    // ===== BANDEAU DE MAINTENANCE (visible pour les comptes whitelistés) =====
    async checkMaintenanceBanner() {
        try {
            const res = await configModule.GetConfig();
            if (!res.maintenance) return;

            if (res.maintenance_end) {
                const endDate = new Date(res.maintenance_end);
                if (!isNaN(endDate.getTime()) && endDate <= new Date()) return;
            }

            this.renderMaintenanceBanner(res.maintenance_message, res.maintenance_end);
        } catch (err) {
            console.error("Erreur lors de la vérification du bandeau maintenance :", err);
        }
    }

    renderMaintenanceBanner(message, endDateISO) {
        let existing = document.querySelector('.maintenance-banner');
        if (existing) existing.remove();

        const banner = document.createElement('div');
        banner.classList.add('maintenance-banner');

        const plainMessage = message.replace(/<br\s*\/?>/gi, ' ');
        banner.innerHTML = `
            <span class="maintenance-banner-icon">⚠</span>
            <span class="maintenance-banner-text">${plainMessage}</span>
            <span class="maintenance-banner-countdown"></span>
        `;

        document.body.appendChild(banner);

        const countdownEl = banner.querySelector('.maintenance-banner-countdown');

        if (!endDateISO) return;

        const endDate = new Date(endDateISO);
        if (isNaN(endDate.getTime())) return;

        const updateCountdown = () => {
            const diffMs = endDate - new Date();

            if (diffMs <= 0) {
                clearInterval(this.maintenanceBannerInterval);
                banner.remove();
                return;
            }

            const totalSeconds = Math.floor(diffMs / 1000);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const pad = (n) => String(n).padStart(2, '0');

            const timeText = `${pad(hours)}h ${pad(minutes)}min ${pad(seconds)}s`;
            const countdownText = days > 0
                ? `Fin dans ${days} jour${days > 1 ? 's' : ''} et ${timeText}`
                : `Fin dans ${timeText}`;

            countdownEl.textContent = countdownText;
        };

        updateCountdown();
        this.maintenanceBannerInterval = setInterval(updateCountdown, 1000);
    }
    // ===== FIN BANDEAU DE MAINTENANCE =====

    async news() {
        let newsContainer = document.querySelector('.news-list');
        let news = await configModule.getNews(this.config).then(res => res).catch(err => false);

        let slides = [];

        if (!news) {
            slides.push({
                title: 'Erreur',
                content: 'Impossible de contacter le serveur des news.<br>Merci de vérifier votre configuration.',
                author: null,
                date: this.getdate(new Date())
            });
        } else if (!news.length) {
            slides.push({
                title: 'Aucune actualité disponible',
                content: 'Vous pourrez suivre ici toutes les news relatives au serveur.',
                author: null,
                date: this.getdate(new Date())
            });
        } else {
            slides = news.map(n => ({
                title: n.title,
                content: n.content.replace(/\n/g, '<br>'),
                author: n.author,
                date: this.getdate(n.publish_date)
            }));
        }

        let current = 0;

        const render = () => {
            const s = slides[current];
            newsContainer.innerHTML = `
                <div class="news-slider">
                    <div class="news-block news-slide">
                        <div class="news-header">
                            <img class="server-status-icon" src="assets/images/icon/icon.png">
                            <div class="header-text">
                                <div class="title">${s.title}</div>
                            </div>
                            <div class="date">
                                <div class="day">${s.date.day}</div>
                                <div class="month">${s.date.month}</div>
                            </div>
                        </div>
                        <div class="news-content">
                            <div class="bbWrapper">
                                <p>${s.content}</p>
                                ${s.author ? `<p class="news-author">Auteur - <span>${s.author}</span></p>` : ''}
                            </div>
                        </div>
                    </div>
                    ${slides.length > 1 ? `
                    <div class="news-slider-controls">
                        <button class="news-arrow news-prev" ${current === 0 ? 'disabled' : ''}>&#8249;</button>
                        <div class="news-dots-wrap">
                            <div class="news-dots">
                                ${slides.map((_, i) => `<span class="news-dot ${i === current ? 'active' : ''}"></span>`).join('')}
                            </div>
                            <div class="news-progress-bar"><div class="news-progress-fill"></div></div>
                        </div>
                        <button class="news-arrow news-next" ${current === slides.length - 1 ? 'disabled' : ''}>&#8250;</button>
                    </div>` : ''}
                </div>`;

            const fillBar = newsContainer.querySelector('.news-progress-fill');
            if (fillBar) {
                fillBar.style.animation = 'none';
                fillBar.offsetHeight; // reflow
                fillBar.style.animation = 'news-progress 12s linear forwards';
            }

            if (slides.length > 1) {
                newsContainer.querySelector('.news-prev')?.addEventListener('click', () => {
                    if (current > 0) { current--; render(); }
                });
                newsContainer.querySelector('.news-next')?.addEventListener('click', () => {
                    if (current < slides.length - 1) { current++; render(); }
                });
                newsContainer.querySelectorAll('.news-dot').forEach((dot, i) => {
                    dot.addEventListener('click', () => { current = i; render(); });
                });
            }

        };

        render();

        if (slides.length > 1) {
            let autoSlideTimer = setInterval(() => {
                const next = (current + 1) % slides.length;
                const block = newsContainer.querySelector('.news-block');
                if (!block) return;

                block.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                block.style.opacity = '0';
                block.style.transform = 'translateX(-20px)';

                setTimeout(() => {
                    current = next;
                    render();

                    const newBlock = newsContainer.querySelector('.news-block');
                    if (newBlock) {
                        newBlock.style.opacity = '0';
                        newBlock.style.transform = 'translateX(20px)';
                        newBlock.style.transition = 'none';
                        requestAnimationFrame(() => {
                            requestAnimationFrame(() => {
                                newBlock.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                                newBlock.style.opacity = '1';
                                newBlock.style.transform = 'translateX(0)';
                            });
                        });
                    }
                }, 400);
            }, 12000);

            const resetTimer = () => {
                clearInterval(autoSlideTimer);
                autoSlideTimer = setInterval(() => {
                    const next = (current + 1) % slides.length;
                    const block = newsContainer.querySelector('.news-block');
                    if (!block) return;
                    block.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                    block.style.opacity = '0';
                    block.style.transform = 'translateX(-20px)';
                    setTimeout(() => {
                        current = next;
                        render();
                        const newBlock = newsContainer.querySelector('.news-block');
                        if (newBlock) {
                            newBlock.style.opacity = '0';
                            newBlock.style.transform = 'translateX(20px)';
                            newBlock.style.transition = 'none';
                            requestAnimationFrame(() => {
                                requestAnimationFrame(() => {
                                    newBlock.style.transition = 'opacity 0.4s ease, transform 0.4s ease';
                                    newBlock.style.opacity = '1';
                                    newBlock.style.transform = 'translateX(0)';
                                });
                            });
                        }
                    }, 400);
                }, 12000);
            };

            newsContainer.addEventListener('click', resetTimer);
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
        let instancesList = await configModule.getInstanceList()
        let instanceSelect = instancesList.find(i => i.name == configClient?.instance_select) ? configClient?.instance_select : null

        // Transmet la liste des instances au processus principal pour qu'il
        // puisse construire le sous-menu "Jouer" du tray.
        // "Event" s'affiche toujours en dernier, que ce soit dans le popup
        // du sélecteur d'instance ou dans le sous-menu "Jouer" du tray.
        const sortedForTray = [...instancesList].sort((a, b) => {
            const aIsEvent = a.name.trim().toLowerCase() === 'event'
            const bIsEvent = b.name.trim().toLowerCase() === 'event'
            if (aIsEvent && !bIsEvent) return 1
            if (!aIsEvent && bIsEvent) return -1
            return 0
        })
        ipcRenderer.send('update-tray-instances', sortedForTray.map(i => i.name))

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


        document.querySelector('.play-btn').addEventListener('click', async () => {
            let configClient = await this.db.readData('configClient')
            this.startGame(configClient.instance_select).catch(err => {

                console.error('Erreur inattendue au lancement :', err)
                this.activeLaunches.delete(configClient.instance_select); notifyTrayRunning();
            })
        })

        document.querySelector('.instance-select').addEventListener('click', async e => {
            let configClient = await this.db.readData('configClient')
            let instanceSelect = configClient.instance_select
            let auth = await this.db.readData('accounts', configClient.account_selected)

            if (true) {

        instancesListPopup.innerHTML = ''

        const buildInstanceHTML = (instance, isActive) => {
            const matchKey = Object.keys(instanceDescriptions).find(
                k => k.trim().toLowerCase() === instance.name.trim().toLowerCase()
            )
            const desc = instance.description || instanceDescriptions[matchKey] || "Aucune description disponible pour cette instance."
            const cls = isActive ? 'instance-elements active-instance' : 'instance-elements'
            const running = this.activeLaunches.has(instance.name) ? ' <span class="instance-running-badge">En cours</span>' : ''
            return `
                <div id="${instance.name}" class="${cls}">
                    <span class="instance-name">${instance.name}${running}</span>
                    <div class="instance-info-icon">?</div>
                    <div class="instance-info-tooltip">${desc}</div>
                </div>`
        }

        const displayList = [...instancesList].sort((a, b) => {
            const aIsEvent = a.name.trim().toLowerCase() === 'event'
            const bIsEvent = b.name.trim().toLowerCase() === 'event'
            if (aIsEvent && !bIsEvent) return 1
            if (!aIsEvent && bIsEvent) return -1
            return 0
        })

        for (let instance of displayList) {
            if (instance.whitelistActive) {
                instance.whitelist.map(whitelist => {
                    if (whitelist == auth?.name) {
                        if (instance.name == instanceSelect) {
                            instancesListPopup.innerHTML += `<div class="glow-container">${buildInstanceHTML(instance, true)}</div>`
                        } else {
                            instancesListPopup.innerHTML += buildInstanceHTML(instance, false)
                        }
                    }
                })
            } else {
                if (instance.name == instanceSelect) {
                    instancesListPopup.innerHTML += buildInstanceHTML(instance, true)
                } else {
                    instancesListPopup.innerHTML += buildInstanceHTML(instance, false)
                }
            }
        }

        instancesListPopup.onclick = async (e) => {
            // Le "?" affiche son info au survol (CSS) ; un clic dessus ou sur
            // le tooltip ne doit jamais sélectionner l'instance en dessous.
            const icon = e.target.closest('.instance-info-icon')
            const tooltip = e.target.closest('.instance-info-tooltip')
            if (icon || tooltip) {
                e.stopPropagation()
                return
            }

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
        })

        instanceCloseBTN.addEventListener('click', () => {
            instancePopup.style.display = 'none'
        })
            }

    async startGame(instanceName) {
        if (this.activeLaunches.has(instanceName)) {
            console.log(`${instanceName} est déjà en cours de lancement ou d'exécution.`)
            return
        }

        let launch = new Launch()
        this.activeLaunches.set(instanceName, launch); notifyTrayRunning();

        let configClient, instanceListAll, authenticator, options
        try {
            configClient = await this.db.readData('configClient')
            instanceListAll = await configModule.getInstanceList()
            authenticator = await this.db.readData('accounts', configClient.account_selected)
            options = instanceListAll.find(i => i.name == instanceName)
            if (!options) throw new Error(`Instance "${instanceName}" introuvable dans la configuration.`)
        } catch (err) {
            console.error('Erreur lors de la préparation du lancement :', err)
            let popupError = new popup()
            popupError.openPopup({
                title: 'Erreur',
                content: err.message || String(err),
                color: 'red',
                options: true
            })
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
            return
        }

        ipcRenderer.send('game-notification', {
            title: 'PatateLand',
            body: `Lancement de ${instanceName}...`
        })

        let opt
        try {
            opt = {
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

            // ===== Injection auto du serveur par défaut (1er lancement uniquement) =====
            // Adapte "instances" ci-dessous si la structure réelle de tes dossiers
            // d'instance est différente (vérifie dans %AppData%/.patateland/).
            const gameDir = path.join(opt.path, 'instances', options.name)
            if (options.status?.ip && options.status?.port) {
                await ensureDefaultServer(gameDir, {
                    name: options.status.nameServer,
                    ip: `${options.status.ip}:${options.status.port}`
                })
            }
            // ===== FIN injection serveur =====

            launch.Launch(opt);
        } catch (err) {
            console.error('Erreur lors du lancement :', err)
            let popupError = new popup()
            popupError.openPopup({
                title: 'Erreur',
                content: err.message || String(err),
                color: 'red',
                options: true
            })
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
            return
        }

        ipcRenderer.send('main-window-progress-load')

        launch.on('extract', extract => {
            ipcRenderer.send('main-window-progress-load')
            console.log(instanceName, extract);
        });

        launch.on('progress', (progress, size) => {
            ipcRenderer.send('main-window-progress', { progress, size })
            ipcRenderer.send('log-send', instanceName, `Téléchargement : ${((progress / size) * 100).toFixed(0)}%`);
        });

        launch.on('check', (progress, size) => {
            ipcRenderer.send('main-window-progress', { progress, size })
        });

        launch.on('estimated', (time) => {
            let hours = Math.floor(time / 3600);
            let minutes = Math.floor((time - hours * 3600) / 60);
            let seconds = Math.floor(time - hours * 3600 - minutes * 60);
            console.log(instanceName, `${hours}h ${minutes}m ${seconds}s`);
        })

        launch.on('speed', (speed) => {
            console.log(instanceName, `${(speed / 1067008).toFixed(2)} Mb/s`)
        })

        launch.on('patch', patch => {
            console.log(instanceName, patch);
            ipcRenderer.send('main-window-progress-load')
        });

        let logWindowOpened = false;
        let readyNotified = false;
        launch.on('data', (e) => {
            const closeMode = configClient.launcher_config.closeLauncher;
            if (closeMode == 'close-launcher') {
                ipcRenderer.send("main-window-minimize");
            } else if (closeMode == 'close-window') {
                ipcRenderer.send("main-window-hide");
            }
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load')
            // Ouvre la fenêtre de logs de cette instance une seule fois, seulement si activée dans les settings
            if (!logWindowOpened && configClient.game_config?.show_console !== false) {
                logWindowOpened = true;
                ipcRenderer.send('log-window-open', instanceName, `PatateLand - ${instanceName}`);
                ipcRenderer.send('log-status', instanceName, 'running');
            }

            if (!readyNotified) {
                readyNotified = true
                ipcRenderer.send('game-notification', {
                    title: 'PatateLand',
                    body: `${instanceName} a démarré !`
                })
            }
            const line = typeof e === 'string' ? e : JSON.stringify(e);
            ipcRenderer.send('log-send', instanceName, line);
            console.log(instanceName, e);
        })

        launch.on('close', code => {
            if (['close-launcher', 'close-window'].includes(configClient.launcher_config.closeLauncher)) {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            ipcRenderer.send('log-status', instanceName, 'closed');
            new logger(pkg.name, '#7289da');
            console.log(instanceName, 'Close');
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
        });

        launch.on('error', err => {
            let popupError = new popup()

            popupError.openPopup({
                title: 'Erreur',
                content: err.error,
                color: 'red',
                options: true
            })

            ipcRenderer.send('game-notification', {
                title: 'PatateLand',
                body: `Erreur au lancement de ${instanceName}.`
            })

            if (['close-launcher', 'close-window'].includes(configClient.launcher_config.closeLauncher)) {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            ipcRenderer.send('log-status', instanceName, 'error');
            ipcRenderer.send('log-send', instanceName, `ERREUR: ${JSON.stringify(err)}`);
            new logger(pkg.name, '#7289da');
            console.log(instanceName, err);
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
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