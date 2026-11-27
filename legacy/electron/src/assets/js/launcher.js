/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
// import panel
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';
import Friends from './panels/friends.js';

import { logger, config, changePanel, database, popup, setBackground, accountSelect, addAccount, pkg } from './utils.js';
const { AZauth, Microsoft, Mojang } = require('minecraft-java-core');

const { ipcRenderer } = require('electron');
const fs = require('fs');
const os = require('os');

class Launcher {
    async init() {
        this.initLog();
        console.log('Initializing Launcher...');
        this.shortcut()
        await setBackground()
        this.initFrame();
        this.config = await config.GetConfig().then(res => res).catch(err => err);
        if (await this.config.error) return this.errorConnect()
        this.db = new database();
        await this.initConfigClient();
        // Friends n'est PLUS géré par createPanels() : ce n'est plus une
        // page plein écran (changePanel), mais un petit flyout autonome
        // (voir friends.js) qui s'ouvre par-dessus l'écran actuel, donc
        // instancié à part.
        this.createPanels(Login, Home, Settings);
        new Friends().init(this.config);
        this.startLauncher();
    }

    initLog() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
                ipcRenderer.send('main-window-dev-tools-close');
                ipcRenderer.send('main-window-dev-tools');
            }
        })
        new logger(pkg.name, '#7289da')
    }

    shortcut() {
        document.addEventListener('keydown', e => {
            if (e.ctrlKey && e.keyCode == 87) {
                ipcRenderer.send('main-window-close');
            }
        })
    }


    errorConnect() {
        new popup().openPopup({
            title: this.config.error.code,
            content: this.config.error.message,
            color: 'red',
            exit: true,
            options: true
        });
    }

    initFrame() {
        console.log('Initializing Frame...')
        const platform = os.platform() === 'darwin' ? "darwin" : "other";

        document.querySelector(`.${platform} .frame`).classList.toggle('hide')

        document.querySelector(`.${platform} .frame #minimize`).addEventListener('click', () => {
            ipcRenderer.send('main-window-minimize');
        });

        let maximized = false;
        let maximize = document.querySelector(`.${platform} .frame #maximize`);
        maximize.addEventListener('click', () => {
            ipcRenderer.send('main-window-maximize');
            maximized = !maximized
            maximize.classList.toggle('icon-maximize')
            maximize.classList.toggle('icon-restore-down')
        });

        document.querySelector(`.${platform} .frame #close`).addEventListener('click', () => {
            ipcRenderer.send('main-window-close');
        })

        // Bouton Amis, créé DYNAMIQUEMENT plutôt qu'écrit en dur deux fois
        // dans launcher.html (une fois pour .darwin, une fois pour .other) :
        // en dur, il apparaissait en double (un exemplaire mal positionné
        // en haut à gauche), signe que le bloc .darwin n'est pas totalement
        // masqué sur Windows par le CSS existant. En le créant uniquement
        // dans le frame réellement actif pour CETTE plateforme, il n'existe
        // jamais qu'à un seul endroit dans le DOM, peu importe le CSS.
        const activeFrame = document.querySelector(`.${platform} .frame`);

        // Wrapper contenant le texte "X/Y" ET l'icône, plutôt qu'une mini-
        // pastille collée sur l'icône (trop petite pour être lisible).
        const friendsWrapper = document.createElement('div');
        friendsWrapper.className = 'friends-frame-wrapper';

        const friendsBadge = document.createElement('span');
        friendsBadge.className = 'friends-online-badge';
        friendsBadge.style.display = 'none';

        const friendsBtn = document.createElement('div');
        friendsBtn.className = 'button-frame friends-frame-btn';
        friendsBtn.title = 'Amis';
        friendsBtn.innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
            <path d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"/>
        </svg><span class="friends-notif-badge" style="display:none;"></span>`;

        friendsWrapper.appendChild(friendsBadge);
        friendsWrapper.appendChild(friendsBtn);

        // Sur Windows/Linux, on l'insère en premier (avant minimiser) pour
        // rester à distance des boutons "destructifs" (fermer) ; sur Mac,
        // à la fin puisque close/minimize/maximize sont dans cet ordre-là.
        if (platform === 'other') {
            activeFrame.insertBefore(friendsWrapper, activeFrame.firstChild);
        } else {
            activeFrame.appendChild(friendsWrapper);
        }

        // PAS de listener changePanel('friends') ici : Friends n'est plus
        // un panel plein écran, c'est un flyout autonome (voir friends.js,
        // wireOpenClose()) qui attache lui-même son propre clic sur ce
        // bouton pour s'ouvrir/se fermer. En avoir un ici EN PLUS causait
        // un crash (.panel.friends n'existe plus dans le DOM), qui lui-même
        // cassait l'affichage du home (la classe .active était retirée du
        // panel courant avant que le crash n'empêche de la remettre).
    }

    async initConfigClient() {
        console.log('Initializing Config Client...')
        let configClient = await this.db.readData('configClient')

        if (!configClient) {
            await this.db.createData('configClient', {
                account_selected: null,
                instance_select: null,
                java_config: {
                    java_path: null,
                    java_memory: {
                        min: 2,
                        max: 4
                    }
                },
                game_config: {
                    screen_size: {
                        width: 1280,
                        height: 720
                    }
                },
                launcher_config: {
                    download_multi: 5,
                    theme: 'auto',
                    closeLauncher: 'close-launcher',
                    intelEnabledMac: true
                }
            })
        }
    }

    createPanels(...panels) {
        let panelsElem = document.querySelector('.panels')
        for (let panel of panels) {
            console.log(`Initializing ${panel.name} Panel...`);
            let div = document.createElement('div');
            div.classList.add('panel', panel.id)
            div.innerHTML = fs.readFileSync(`${__dirname}/panels/${panel.id}.html`, 'utf8');
            panelsElem.appendChild(div);
            new panel().init(this.config);
        }
    }

    async refreshAccount(account, account_selected, configClient) {
        const account_ID = account.ID;

        try {
            if (account.meta.type === 'Xbox') {
                console.log(`Account Type: ${account.meta.type} | Username: ${account.name}`);
                let refresh_accounts = await new Microsoft(this.config.client_id).refresh(account);

                if (refresh_accounts.error) throw new Error(refresh_accounts.errorMessage || 'Erreur de rafraîchissement Xbox');

                refresh_accounts.ID = account_ID;
                await this.db.updateData('accounts', refresh_accounts, account_ID);
                await addAccount(refresh_accounts);
                if (account_ID == account_selected) accountSelect(refresh_accounts);

            } else if (account.meta.type === 'AZauth') {
                console.log(`Account Type: ${account.meta.type} | Username: ${account.name}`);
                let refresh_accounts = await new AZauth(this.config.online).verify(account);

                if (refresh_accounts.error) throw new Error(refresh_accounts.message || 'Erreur de rafraîchissement AZauth');

                refresh_accounts.ID = account_ID;
                await this.db.updateData('accounts', refresh_accounts, account_ID);
                await addAccount(refresh_accounts);
                if (account_ID == account_selected) accountSelect(refresh_accounts);

            } else if (account.meta.type === 'Mojang') {
                console.log(`Account Type: ${account.meta.type} | Username: ${account.name}`);

                if (account.meta.online === false) {
                    let refresh_accounts = await Mojang.login(account.name);
                    refresh_accounts.ID = account_ID;
                    await addAccount(refresh_accounts);
                    await this.db.updateData('accounts', refresh_accounts, account_ID);
                    if (account_ID == account_selected) accountSelect(refresh_accounts);
                    return;
                }

                let refresh_accounts = await Mojang.refresh(account);

                if (refresh_accounts.error) throw new Error(refresh_accounts.errorMessage || 'Erreur de rafraîchissement Mojang');

                refresh_accounts.ID = account_ID;
                await this.db.updateData('accounts', refresh_accounts, account_ID);
                await addAccount(refresh_accounts);
                if (account_ID == account_selected) accountSelect(refresh_accounts);

            } else {
                throw new Error('Account Type Not Found');
            }

        } catch (err) {

            console.error(`[Account] ${account.name}: ${err.message || err}`);
            await this.db.deleteData('accounts', account_ID);
            if (account_ID == account_selected) {
                configClient.account_selected = null;
                await this.db.updateData('configClient', configClient);
            }
        }
    }

    async startLauncher() {
        let accounts = await this.db.readAllData('accounts')
        let configClient = await this.db.readData('configClient')
        let account_selected = configClient ? configClient.account_selected : null
        let popupRefresh = new popup();

        try {
            if (accounts?.length) {
                popupRefresh.openPopup({
                    title: 'Connexion',
                    content: 'Vérification de vos comptes en cours...',
                    color: 'var(--color)',
                    background: false
                });

                for (let account of accounts) {
                    await this.refreshAccount(account, account_selected, configClient);
                }

                accounts = await this.db.readAllData('accounts')
                configClient = await this.db.readData('configClient')
                account_selected = configClient ? configClient.account_selected : null

                if (!account_selected && accounts.length) {
                    let uuid = accounts[0].ID
                    if (uuid) {
                        configClient.account_selected = uuid
                        await this.db.updateData('configClient', configClient)
                        accountSelect(uuid)
                    }
                }

                if (!accounts.length) {
                    configClient.account_selected = null
                    await this.db.updateData('configClient', configClient);
                    return changePanel("login");
                }

                changePanel("home");
            } else {
                changePanel('login');
            }
        } catch (err) {

            console.error('Erreur inattendue lors du démarrage du launcher :', err);
            changePanel('login');
        } finally {
            popupRefresh.closePopup();
        }
    }
}

new Launcher().init();