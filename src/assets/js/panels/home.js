/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
import { config as configModule, database, logger, changePanel, appdata, setStatus, pkg, popup } from '../utils.js'
import { injectServer } from '../utils/serversDat.js'
// PROTOTYPE test_ (voir test_cosmetics-mod/) : injection du mod de
// cosmétiques dans les instances Forge avant lancement, pour pouvoir
// tester directement via "npm start" + clic sur JOUER, sans copier le jar
// à la main à chaque rebuild. À retirer/refaire proprement une fois le
// système de cosmétiques validé (téléchargement du jar, pas seulement
// build local, etc.)
// NOTE : les chemins relatifs de require() ici se résolvent par rapport à
// launcher.html (voir utils.js -> require('../package.json')), PAS par
// rapport à ce fichier home.js — d'où le chemin depuis src/ et non depuis
// src/assets/js/panels/.
const { injectCosmeticsMod, findCosmeticsJar } = require('./assets/js/test_cosmeticsInjector.js')

const { Launch } = require('minecraft-java-core')
const { shell, ipcRenderer } = require('electron')
const fs = require('fs')
const path = require('path')
const os = require('os')

// ===== WEBHOOK DISCORD POUR LES CRASH REPORTS (lecture protégée) =====
// __dirname est la bonne approche ici : le fichier est embarqué dans le
// build (voir build.js -> Obfuscate(), qui copie tout src/ vers app/ en
// préservant l'arborescence), donc TOUS les joueurs qui téléchargent le
// launcher l'ont automatiquement, sans rien à faire de leur côté.
//
// Condition impérative : le fichier doit exister sur le disque, AU MÊME
// NIVEAU que home.js lui-même (confirmé empiriquement : dans ce build,
// home.js vit dans app/assets/js/panels/, donc le webhook doit être une
// copie dans src/assets/js/panels/webhook.config.json — PAS juste à la
// racine de src/), et ce AVANT de lancer `npm run build`. Le script ne
// fait que COPIER ce qui existe déjà dans src/ vers app/, il ne peut rien
// inventer après coup. Un .asar une fois construit est une archive figée,
// impossible d'y ajouter quoi que ce soit une fois le build terminé.
//
// Crée "webhook.config.json" à côté de ce fichier avec ce contenu :
//   { "CRASH_REPORT_DISCORD_WEBHOOK": "https://discord.com/api/webhooks/..." }
//
// .replace(/^\uFEFF/, '') : retire un éventuel BOM (Byte Order Mark) en
// tout début de fichier — certains outils (dont PowerShell avec
// -Encoding utf8) l'ajoutent silencieusement, invisible à l'oeil nu, mais
// JSON.parse refuse de le lire ("Unexpected token '\uFEFF'"). Ne change
// rien si le fichier n'a pas de BOM.
// __dirname s'est révélé INSTABLE d'un build à l'autre (constaté en
// conditions réelles : tantôt "app/", tantôt "app/assets/js/panels/" selon
// le build, sans cause identifiée côté build.js/webpack). Plutôt que de
// parier sur un seul chemin fixe, on essaie plusieurs emplacements
// plausibles dans l'ordre, et on prend le premier qui existe.
function getCrashReportWebhook() {
    const candidates = [
        path.join(__dirname, 'webhook.config.json'),
        path.join(__dirname, '..', '..', 'webhook.config.json'), // remonte de app/assets/js/panels/ vers app/
        path.join(__dirname, 'assets', 'js', 'panels', 'webhook.config.json'), // si __dirname est déjà app/
    ];

    let configPath = candidates.find(p => fs.existsSync(p));

    if (!configPath) {
        console.warn('[CrashReporter] webhook.config.json introuvable. Emplacements essayés :', candidates.join(' | '));
        console.warn('[CrashReporter] -> Vérifie qu\'il existe bien dans src/ (racine ET/OU src/assets/js/panels/) AVANT de relancer npm run build.');
        return '';
    }

    try {
        const raw = fs.readFileSync(configPath, 'utf-8').replace(/^\uFEFF/, '');
        const parsed = JSON.parse(raw);
        const webhook = parsed?.CRASH_REPORT_DISCORD_WEBHOOK || '';
        if (webhook) {
            console.log('[CrashReporter] webhook.config.json trouvé et lu (', configPath, ') — envoi Discord disponible (si activé dans les Paramètres).');
        } else {
            console.warn('[CrashReporter] webhook.config.json trouvé (', configPath, ') mais CRASH_REPORT_DISCORD_WEBHOOK est vide ou absent dedans.');
        }
        return webhook;
    } catch (err) {
        console.error('[CrashReporter] webhook.config.json illisible ou invalide (fonctionnalité optionnelle, désactivée) :', err);
        return '';
    }
}

const CRASH_REPORT_DISCORD_WEBHOOK = getCrashReportWebhook();
// ===== FIN WEBHOOK DISCORD =====

// Descriptions affichées via l'icône "?" pour chaque instance.
// Les clés doivent correspondre exactement au champ "name" de l'instance.
const instanceDescriptions = {
    "Event": "Instance dédiée aux événements spéciaux et temporaires.",
    "Extra": "Instance avec des fonctionnalités et du contenu supplémentaire.",
    "Opti": "Instance optimisée pour de meilleures performances, idéale pour les configurations modestes."
}

const activeLaunches = new Map();

function notifyTrayRunning() {
    ipcRenderer.send('update-tray-running', Array.from(activeLaunches.keys()));
}

class Home {
    static id = "home";

    async init(config) {
        this.config = config;
        this.db = new database();
        this.activeLaunches = activeLaunches;

        this.news()
        this.socialLick()
        this.instancesSelect()
        this.reviewBanner()
        this.partnerBanner()

        const db = this.db;
        setInterval(async () => {
            try {
                let configClient = await db.readData('configClient')
                let instanceList = await configModule.getInstanceList()
                let options = instanceList.find(i => i.name == configClient.instance_select)
                if (options?.status) await setStatus(options.status)
            } catch(e) { console.log("INTERVAL ERR:", e.message) }
        }, 15000)

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
    }

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
                fillBar.offsetHeight;
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

    async reviewBanner() {
        await new Promise(resolve => setTimeout(resolve, 1000));

        let configClient = await this.db.readData('configClient');

        const currentAccountId = configClient?.account_selected;
        const dismissedAccounts = configClient?.launcher_config?.review_dismissed_accounts || [];

        if (currentAccountId && dismissedAccounts.includes(currentAccountId)) return;

        const homePanel = document.querySelector('.panel.home');
        if (!homePanel) return;

        const banner = document.createElement('div');
        banner.classList.add('review-banner');
        banner.innerHTML = `
            <span class="review-banner-icon">⭐</span>
            <span class="review-banner-text">Vous appréciez le launcher ? Laissez un avis sur le site !</span>
            <span class="review-banner-btn">Évaluer</span>
            <span class="review-banner-close">✕</span>
        `;

        homePanel.appendChild(banner);

        const alignBannerToSettingsBtn = () => {
            const sidebar = document.querySelector('.sidebar');
            if (!sidebar) return;
            const rect = sidebar.getBoundingClientRect();
            const rightOffset = window.innerWidth - rect.right;
            banner.style.right = `${rightOffset}px`;
        };

        alignBannerToSettingsBtn();
        window.addEventListener('resize', alignBannerToSettingsBtn);

        const dismissForCurrentAccount = async () => {
            let cfg = await this.db.readData('configClient');
            const accountId = cfg?.account_selected;
            if (!accountId) return;

            if (!cfg.launcher_config) cfg.launcher_config = {};
            if (!cfg.launcher_config.review_dismissed_accounts) cfg.launcher_config.review_dismissed_accounts = [];

            if (!cfg.launcher_config.review_dismissed_accounts.includes(accountId)) {
                cfg.launcher_config.review_dismissed_accounts.push(accountId);
            }
            await this.db.updateData('configClient', cfg);
        };

        banner.querySelector('.review-banner-btn').addEventListener('click', async () => {
            shell.openExternal('https://patateland.wstr.fr/review');
            banner.remove();
            await dismissForCurrentAccount();
        });

        banner.querySelector('.review-banner-close').addEventListener('click', async () => {
            banner.remove();
            await dismissForCurrentAccount();
        });
    }

    async partnerBanner() {
        const partner = {
            name: 'MineStrator',
            iconSrc: 'assets/images/svgs/S%20BLANC.svg',
            title: 'Serveur hébergé avec MineStrator !',
            text: `MineStrator, c'est l'hébergeur FR ultra fiable pour tes serveurs Minecraft, moddés, plugins, ou même autres jeux !`,
            code: 'LACRIMO',
            discount: '-10%',
            url: 'https://minestrator.com/a/LACRIMO'
        };

        const newTab = document.querySelector('.new-tab');
        if (!newTab) return;

        let existing = document.querySelector('.partner-banner-card');
        if (existing) existing.remove();

        const card = document.createElement('div');
        card.classList.add('partner-banner-card');
        card.innerHTML = `
            <img class="partner-banner-icon" src="${partner.iconSrc}" alt="${partner.name}">
            <div class="partner-banner-body">
                <div class="partner-banner-title">${partner.title}</div>
                <div class="partner-banner-text">
                    ${partner.text}
                    <span class="partner-banner-code-inline">Profite de <b>${partner.discount}</b> avec le code <span class="partner-banner-code">${partner.code}</span></span>
                </div>
            </div>
            <div class="partner-banner-actions">
                <span class="partner-banner-btn">Découvrir ${partner.name} →</span>
            </div>
        `;

        newTab.appendChild(card);

        card.querySelector('.partner-banner-btn').addEventListener('click', () => {
            shell.openExternal(partner.url);
        });
    }

    async instancesSelect() {
        let configClient = await this.db.readData('configClient')
        let auth = await this.db.readData('accounts', configClient.account_selected)
        let instancesList = await configModule.getInstanceList()
        let instanceSelect = instancesList.find(i => i.name == configClient?.instance_select) ? configClient?.instance_select : null

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
                detached: false,
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
                    min: `${Math.round(configClient.java_config.java_memory.min * 1024)}M`,
                    max: `${Math.round(configClient.java_config.java_memory.max * 1024)}M`
                }
            }

            // PROTOTYPE test_ : voir l'import en haut du fichier. Best-effort
            // uniquement — une erreur ici ne doit jamais empêcher le jeu de
            // se lancer normalement. __dirname varie selon dev ("npm start",
            // vise directement src/assets/js/panels/) vs build (voir
            // getCrashReportWebhook plus haut) : on essaie plusieurs racines
            // candidates plutôt que de parier sur une seule.
            try {
                const candidateRoots = [
                    path.join(__dirname, '..', '..', '..', '..'), // src/assets/js/panels -> racine repo (dev, npm start)
                    path.join(__dirname, '..', '..', '..'),       // app/assets/js/panels -> app (build)
                    path.join(__dirname, '..'),                   // app -> app (autre variante de build constatée)
                ];
                const buildLibsCandidates = candidateRoots
                    .map(root => findCosmeticsJar(path.join(root, 'test_cosmetics-mod', 'build', 'libs')));
                // .exe packagé (electron-builder) : test_cosmetics-mod/ n'est
                // PAS dans app.asar (seul "app/**/*" y est embarqué, voir
                // build.js -> files) — le jar est copié à part en tant
                // qu'extraResource, à plat, dans resources/test_cosmetics-mod/
                // (voir build.js -> extraResources), donc pas sous build/libs
                // ici. process.resourcesPath n'existe qu'en Electron packagé
                // (undefined en dev, d'où le contrôle avant utilisation).
                const packagedCandidate = process.resourcesPath
                    ? findCosmeticsJar(path.join(process.resourcesPath, 'test_cosmetics-mod'))
                    : null;
                const cosmeticsJar = [...buildLibsCandidates, packagedCandidate].find(Boolean);
                if (cosmeticsJar) {
                    const injected = injectCosmeticsMod(
                        path.join(opt.path, 'instances', options.name),
                        options.loader.loader_type,
                        cosmeticsJar
                    );
                    if (injected) {
                        // IMPORTANT : minecraft-java-core fait le ménage des
                        // fichiers d'instance absents du manifest distant
                        // (MineStrator) ET absents de `ignored` (voir
                        // Minecraft-Bundle.js -> checkFiles()) — sans ça,
                        // notre jar est supprimé juste après avoir été copié,
                        // avant même que Forge ne le charge.
                        opt.ignored.push(`mods/${path.basename(cosmeticsJar)}`);
                    }
                }

                // UUID "réel" (celui du compte AZauth/site, PAS forcément
                // celui que Minecraft attribuera en jeu) — sur un serveur
                // public en mode offline, le serveur calcule lui-même un
                // UUID à partir du pseudo (formule "OfflinePlayer:<pseudo>"),
                // qui ne correspond PAS au compte du site. On écrit donc ici
                // l'UUID connu avec certitude par le launcher (celui utilisé
                // pour se connecter), pour que le mod puisse s'en servir pour
                // SES PROPRES cosmétiques au lieu de faire confiance à
                // l'UUID (potentiellement faux) que le serveur lui attribue.
                // Ignoré silencieusement si l'auth n'a pas d'UUID exploitable.
                if (authenticator?.uuid) {
                    const sessionFile = path.join(opt.path, 'instances', options.name, 'config', 'testcosmetics_session.json');
                    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
                    fs.writeFileSync(sessionFile, JSON.stringify({
                        uuid: authenticator.uuid,
                        name: authenticator.name
                    }));
                    opt.ignored.push('config/testcosmetics_session.json');
                }
            } catch (err) {
                console.warn('[test_cosmeticsInjector] Injection ignorée :', err);
            }

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

        const launchedAt = Date.now();
        const crashReportsDir = path.join(opt.path, 'instances', options.name, 'crash-reports');

        ipcRenderer.send('main-window-progress-load')

        let logWindowOpened = false;
        const ensureLogWindowOpen = () => {
            if (logWindowOpened) return;
            logWindowOpened = true;
            ipcRenderer.send('log-window-open', instanceName, `PatateLand - ${instanceName}`);
        };

        launch.on('extract', extract => {
            ipcRenderer.send('main-window-progress-load')
            console.log(`${instanceName}: ${extract}`);
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
            console.log(`${instanceName}: ${hours}h ${minutes}m ${seconds}s`);
        })

        launch.on('speed', (speed) => {
            console.log(`${instanceName}: ${(speed / 1067008).toFixed(2)} Mb/s`)
        })

        launch.on('patch', patch => {
            console.log(`${instanceName}: ${JSON.stringify(patch)}`);
            ipcRenderer.send('main-window-progress-load')
        });

        let readyNotified = false;
        let serversInjected = false;
        let windowAutoHidden = false;
        launch.on('data', (e) => {
            if (!serversInjected) {
                serversInjected = true;
                const instancePath = path.join(opt.path, 'instances', options.name);
                injectServer(instancePath, instanceName);
            }

            if (!windowAutoHidden) {
                windowAutoHidden = true;
                const closeMode = configClient.launcher_config.closeLauncher;
                if (closeMode == 'close-launcher') {
                    ipcRenderer.send("main-window-minimize");
                } else if (closeMode == 'close-window') {
                    ipcRenderer.send("main-window-hide");
                }
            }
            new logger('Minecraft', '#36b030');
            ipcRenderer.send('main-window-progress-load')
            if (!logWindowOpened && configClient.game_config?.show_console !== false) {
                ensureLogWindowOpen();
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
            console.log(`${instanceName}: ${typeof e === 'string' ? e : JSON.stringify(e)}`);
        })

        launch.on('close', code => {
            if (['close-launcher', 'close-window'].includes(configClient.launcher_config.closeLauncher)) {
                ipcRenderer.send("main-window-show")
            };
            ipcRenderer.send('main-window-progress-reset')
            ipcRenderer.send('log-status', instanceName, 'closed');
            new logger(pkg.name, '#7289da');
            console.log(`${instanceName} - Close - exit code: ${code} (type: ${typeof code})`);
            this.activeLaunches.delete(instanceName); notifyTrayRunning();

            if (code !== 0) {
                this.handleCrash(instanceName, crashReportsDir, launchedAt, authenticator?.name, authenticator?.uuid, ensureLogWindowOpen);
            }
        });

        launch.on('error', err => {
            ensureLogWindowOpen();

            let popupError = new popup()

            const errorMessage = err?.error
                || err?.message
                || (typeof err === 'string' ? err : null)
                || (() => { try { return JSON.stringify(err) } catch { return null } })()
                || 'Erreur inconnue lors du lancement. Consulte la console de jeu pour plus de détails.'

            popupError.openPopup({
                title: 'Erreur',
                content: errorMessage,
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
            console.log(`${instanceName} - ${err?.message || err}`);
            this.activeLaunches.delete(instanceName); notifyTrayRunning();
        });
    }

    async handleCrash(instanceName, crashReportsDir, launchedAt, playerName, playerUuid, ensureLogWindowOpen) {
        console.log(`${instanceName} - [CrashReporter] Crash détecté (code de sortie anormal).`);
        try {
            if (!fs.existsSync(crashReportsDir)) {
                console.log(`${instanceName} - [CrashReporter] Aucun crash report trouvé (dossier introuvable) : ${crashReportsDir}`);
                return;
            }

            console.log(`${instanceName} - [CrashReporter] Recherche du crash report dans ${crashReportsDir} ...`);
            const allFiles = fs.readdirSync(crashReportsDir);

            const files = allFiles
                .filter(f => f.toLowerCase().endsWith('.txt'))
                .map(f => {
                    const fullPath = path.join(crashReportsDir, f);
                    return { fullPath, mtime: fs.statSync(fullPath).mtimeMs };
                })
                .filter(f => f.mtime >= launchedAt - 5000)
                .sort((a, b) => b.mtime - a.mtime);

            if (!files.length) {
                console.log(`${instanceName} - [CrashReporter] Aucun crash report trouvé (aucun fichier récent parmi ${allFiles.length} fichier(s) présent(s)).`);
                return;
            }

            const report = files[0];
            console.log(`${instanceName} - [CrashReporter] Crash report trouvé : ${report.fullPath}`);

            ensureLogWindowOpen();

            console.log(`${instanceName} - [CrashReporter] Lecture du rapport...`);
            const content = fs.readFileSync(report.fullPath, 'utf-8');
            console.log(`${instanceName} - [CrashReporter] Rapport lu (${content.length} caractères).`);

            ipcRenderer.send('log-status', instanceName, 'crashed');
            ipcRenderer.send('log-send', instanceName,
                `===CRASH_REPORT===\nPATH:${report.fullPath}\n${content}\n===END_CRASH_REPORT===`);

            this.sendCrashReportToDiscord(instanceName, playerName, playerUuid, report.fullPath, content);
        } catch (err) {
            console.error(`${instanceName} - [CrashReporter] Erreur inattendue lors de la lecture du rapport de crash : ${err?.message || err}`);
        }
    }

    async sendCrashReportToDiscord(instanceName, playerName, playerUuid, reportPath, content) {
        console.log(`${instanceName} - [CrashReporter] Envoi du rapport vers Discord...`);

        if (!CRASH_REPORT_DISCORD_WEBHOOK) {
            console.warn(`${instanceName} - [CrashReporter] Envoi annulé : aucun webhook configuré (CRASH_REPORT_DISCORD_WEBHOOK est vide).`);
            console.warn(`${instanceName} - [CrashReporter] -> Vérifie que webhook.config.json existait bien, au bon endroit, AVANT le dernier npm run build.`);
            return;
        }

        const cfg = await this.db.readData('configClient');
        if (!cfg?.launcher_config?.send_crash_reports) {
            console.warn(`${instanceName} - [CrashReporter] Envoi annulé : option désactivée dans les Paramètres > LAUNCHER > Rapports de crash.`);
            return;
        }

        try {
            const fileName = path.basename(reportPath);

            // mc-heads.net accepte un pseudo directement (pas que l'UUID) et
            // fait la résolution Mojang lui-même -> rendu isométrique 3D,
            // contrairement à la route skin-api du site qui ne fait qu'un
            // rendu plat 2D. Confirmé fonctionnel avec le vrai pseudo.
            const skinHeadUrl = `https://mc-heads.net/head/${encodeURIComponent(playerName || 'MHF_Steve')}/128`;

            const osNameMap = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
            const osLine = `${osNameMap[process.platform] || process.platform} ${os.release()} (${os.arch()})`;

            const cpus = os.cpus();
            const cpuLine = cpus.length ? `${cpus[0].model} (${cpus.length} coeurs)` : 'Inconnu';

            const totalMemGb = Math.round(os.totalmem() / 1073741824 * 10) / 10;

            let gpuLine = 'Inconnu';
            try {
                const gpuInfo = await ipcRenderer.invoke('get-gpu-info');
                const device = gpuInfo?.gpuDevice?.[0];
                if (device) gpuLine = device.deviceString || device.vendorString || 'Inconnu';
            } catch (err) {
                console.error(`${instanceName} - [CrashReporter] Erreur lors de la récupération des infos GPU : ${err?.message || err}`);
            }

            const payload = {
                embeds: [{
                    title: `💥 Crash détecté — ${instanceName}`,
                    color: 0xe74c3c,
                    thumbnail: { url: skinHeadUrl },
                    fields: [
                        { name: 'Joueur', value: playerName || 'Inconnu', inline: true },
                        { name: 'Instance', value: instanceName, inline: true },
                        { name: 'OS', value: osLine, inline: true },
                        { name: 'CPU', value: cpuLine, inline: true },
                        { name: 'RAM totale', value: `${totalMemGb} Go`, inline: true },
                        { name: 'GPU', value: gpuLine, inline: true },
                        { name: 'Date', value: new Date().toLocaleString('fr-FR'), inline: false }
                    ]
                }]
            };

            const MAX_ATTACHMENT_CHARS = 900_000;
            let attachedContent = content;
            if (Buffer.byteLength(content, 'utf-8') > MAX_ATTACHMENT_CHARS) {
                console.warn(`${instanceName} - [CrashReporter] Rapport trop volumineux (${content.length} caractères), troncature à ${MAX_ATTACHMENT_CHARS} caractères avant envoi.`);
                attachedContent = content.slice(0, MAX_ATTACHMENT_CHARS) + '\n\n[...rapport tronqué, trop volumineux pour Discord...]';
            }

            const formData = new FormData();
            formData.append('payload_json', JSON.stringify(payload));
            formData.append('files[0]', new Blob([attachedContent], { type: 'text/plain' }), fileName);

            console.log(`${instanceName} - [CrashReporter] Webhook appelé...`);
            const res = await fetch(CRASH_REPORT_DISCORD_WEBHOOK, {
                method: 'POST',
                body: formData
            });

            console.log(`${instanceName} - [CrashReporter] Réponse Discord : ${res.status}`);

            if (res.ok) {
                console.log(`${instanceName} - [CrashReporter] Rapport envoyé avec succès.`);
            } else {
                const bodyText = await res.text().catch(() => '(impossible de lire le corps de la réponse)');
                console.error(`${instanceName} - [CrashReporter] Échec de l'envoi Discord.`);
                console.error(`${instanceName} - [CrashReporter] HTTP : ${res.status}`);
                console.error(`${instanceName} - [CrashReporter] Réponse : ${JSON.stringify(bodyText)}`);
            }
        } catch (err) {
            console.error(`${instanceName} - [CrashReporter] Erreur réseau/inattendue lors de l'envoi vers Discord : ${err?.message || err}`);
        }
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