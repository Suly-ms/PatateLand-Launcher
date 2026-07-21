/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */
// import panel
import Login from './panels/login.js';
import Home from './panels/home.js';
import Settings from './panels/settings.js';

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
        this.createPanels(Login, Home, Settings);
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
            if (maximized) ipcRenderer.send('main-window-maximize')
            else ipcRenderer.send('main-window-maximize');
            maximized = !maximized
            maximize.classList.toggle('icon-maximize')
            maximize.classList.toggle('icon-restore-down')
        });

        document.querySelector(`.${platform} .frame #close`).addEventListener('click', () => {
            ipcRenderer.send('main-window-close');
        })
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