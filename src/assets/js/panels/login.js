/**
 * @author Luuxis
 * Luuxis License v1.0
 */

// --- LIBRAIRIES EXTERNES (require) ---
const { AZauth, Mojang } = require('minecraft-java-core');
const { ipcRenderer } = require('electron');

// --- VOS FICHIERS LOCAUX (import) ---
import { popup, database, changePanel, accountSelect, addAccount, config, setStatus } from '../utils.js';

class Login {
    static id = "login";

    async init(config) {
        this.config = config;
        this.db = new database();
        
        // --- AUTO LOGIN ---
        const isAutoLogged = await this.tryAutoLogin();
        if (isAutoLogged) {
            console.log("Auto-login success!");
            return; 
        }

        if (typeof this.config.online == 'boolean') {
            this.config.online ? this.getMicrosoft() : this.getCrack();
        } else if (typeof this.config.online == 'string') {
            if (this.config.online.match(/^(http|https):\/\/[^ "]+$/)) {
                this.getAZauth();
            }
        }
        
        const cancelBtn = document.querySelector('.cancel-home');
        if(cancelBtn) {
            const newBtn = cancelBtn.cloneNode(true);
            cancelBtn.parentNode.replaceChild(newBtn, cancelBtn);
            newBtn.addEventListener('click', () => {
                newBtn.style.display = 'none';
                changePanel('settings');
            });
        }
    }

    async tryAutoLogin() {
        console.log("--- DÉBUT AUTO-LOGIN (V3 FINAL) ---");
        try {
            // ÉTAPE 1 : Lecture Config
            const configClient = await this.db.readData('configClient');
            if (!configClient || !configClient.account_selected) { 
                console.log("Auto-Login: Pas de compte sélectionné dans la config."); 
                return false; 
            }

            // ÉTAPE 2 : Lecture et Conversion des Comptes
            let accountsData = await this.db.readData('accounts');
            let accountsList = [];

            // --- CORRECTION INTELLIGENTE ---
            if (Array.isArray(accountsData)) {
                // Cas 1 : C'est déjà une liste parfaite
                accountsList = accountsData;
            } else if (accountsData && typeof accountsData === 'object') {
                // Cas 2 : C'est un objet/dictionnaire, on le transforme en liste
                console.log("Auto-Login: Format Objet détecté, conversion en liste...");
                // On prend toutes les valeurs contenues dans l'objet
                accountsList = Object.values(accountsData);
                
                // Sous-cas : Parfois c'est encapsulé dans { accounts: [...] }
                if (accountsData.accounts && Array.isArray(accountsData.accounts)) {
                    accountsList = accountsData.accounts;
                }
            } else {
                console.warn("Auto-Login: Format de données inconnu ou vide.");
                return false;
            }
            // -------------------------------

            console.log(`Auto-Login: ${accountsList.length} comptes trouvés en base.`);

            // ÉTAPE 3 : Recherche du compte
            // On s'assure que tout est en String pour la comparaison
            const targetID = String(configClient.account_selected);
            
            const savedAccount = accountsList.find(acc => {
                if (!acc) return false;
                // On cherche par ID ou par UUID
                return String(acc.ID) === targetID || String(acc.uuid) === targetID;
            });
            
            if (!savedAccount) { 
                console.log(`Auto-Login: Compte ID ${targetID} introuvable dans la liste.`); 
                return false; 
            }

            console.log(`Auto-Login: Compte identifié -> ${savedAccount.name} (${savedAccount.type})`);

            // ÉTAPE 4 : Validation et Connexion
            // On réutilise la logique de connexion
            
            // Microsoft
            if (savedAccount.type === 'Microsoft') {
                await this.saveData(savedAccount); 
                return true;
            }

            // Crack / Offline
            if (savedAccount.type === 'Offline') {
                const { Mojang } = require('minecraft-java-core');
                const connect = await Mojang.login(savedAccount.name);
                connect.type = 'Offline'; 
                await this.saveData(connect);
                return true;
            }

            // AZauth (Gestion large)
            const isAzAuth = savedAccount.type === 'AZauth' || 
                             savedAccount.meta?.type === 'AZauth' || 
                             (this.config.online && typeof this.config.online === 'string' && this.config.online.includes('http'));

            if (isAzAuth) {
               savedAccount.type = 'AZauth'; // On force le type pour être sûr
               await this.saveData(savedAccount);
               return true;
            }

            console.log("Auto-Login: Type de compte non géré automatiquement.");
            return false;

        } catch (error) {
            console.error("CRASH AUTO-LOGIN :", error);
            return false; 
        }
    }

    async getMicrosoft() {
        console.log('Initializing Microsoft login...');
        const popupLogin = new popup();
        const loginHome = document.querySelector('.login-home');
        const microsoftBtn = document.querySelector('.connect-home');
        
        if(loginHome) loginHome.style.display = 'block';

        const newBtn = microsoftBtn.cloneNode(true);
        microsoftBtn.parentNode.replaceChild(newBtn, microsoftBtn);

        newBtn.addEventListener("click", () => {
            popupLogin.openPopup({ title: 'Connexion', content: 'Veuillez patienter...', color: 'var(--color)' });

            ipcRenderer.invoke('Microsoft-window', this.config.client_id)
                .then(async account_connect => {
                    if (!account_connect || account_connect === 'cancel') {
                        popupLogin.closePopup();
                        return;
                    }
                    account_connect.type = 'Microsoft'; 
                    await this.saveData(account_connect);
                    popupLogin.closePopup();
                })
                .catch(err => {
                    popupLogin.openPopup({ title: 'Erreur', content: err, options: true });
                });
        });
    }

    async getCrack() {
        console.log('Initializing offline login...');
        const popupLogin = new popup();
        const loginOffline = document.querySelector('.login-offline');
        const emailOffline = document.querySelector('.email-offline');
        const connectOffline = document.querySelector('.connect-offline');
        
        if(loginOffline) loginOffline.style.display = 'block';

        const newBtn = connectOffline.cloneNode(true);
        connectOffline.parentNode.replaceChild(newBtn, connectOffline);

        newBtn.addEventListener('click', async () => {
            if (emailOffline.value.length < 3 || emailOffline.value.match(/\s/)) {
                popupLogin.openPopup({ title: 'Erreur', content: 'Pseudo invalide.', options: true });
                return;
            }

            try {
                const MojangConnect = await Mojang.login(emailOffline.value);
                MojangConnect.type = 'Offline'; 
                await this.saveData(MojangConnect);
                popupLogin.closePopup();
            } catch (err) {
                popupLogin.openPopup({ title: 'Erreur', content: err.message || err, options: true });
            }
        });
    }

    async getAZauth() {
        console.log('Initializing AZauth login...');
        const AZauthClient = new AZauth(this.config.online);
        const PopupLogin = new popup();
        
        const loginAZauth = document.querySelector('.login-AZauth');
        const loginAZauthA2F = document.querySelector('.login-AZauth-A2F');
        const AZauthEmail = document.querySelector('.email-AZauth');
        const AZauthPassword = document.querySelector('.password-AZauth');
        const AZauthA2F = document.querySelector('.A2F-AZauth');
        
        if(loginAZauth) loginAZauth.style.display = 'block';

        const cleanBtn = (sel) => {
            const el = document.querySelector(sel);
            if(!el) return null;
            const clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
            return clone;
        }

        const btnConnect = cleanBtn('.connect-AZauth');
        const btnA2F = cleanBtn('.connect-AZauth-A2F');
        const btnCancelA2F = cleanBtn('.cancel-AZauth-A2F');

        let tempUser = '', tempPass = '';

        if(btnConnect) {
            btnConnect.addEventListener('click', async () => {
                PopupLogin.openPopup({ title: 'Connexion...', content: 'Patientez...', color: 'var(--color)' });
                
                if (!AZauthEmail.value || !AZauthPassword.value) {
                    PopupLogin.openPopup({ title: 'Erreur', content: 'Remplissez tout.', options: true });
                    return;
                }

                tempUser = AZauthEmail.value;
                tempPass = AZauthPassword.value;

                const res = await AZauthClient.login(tempUser, tempPass);

                if (res.error) {
                    PopupLogin.openPopup({ title: 'Erreur', content: res.message, options: true });
                } else if (res.A2F) {
                    PopupLogin.closePopup();
                    loginAZauth.style.display = 'none';
                    loginAZauthA2F.style.display = 'block';
                } else {
                    res.type = 'AZauth'; 
                    await this.saveData(res);
                    PopupLogin.closePopup();
                }
            });
        }

        if(btnA2F) {
            btnA2F.addEventListener('click', async () => {
                PopupLogin.openPopup({ title: 'A2F...', content: 'Vérification...', color: 'var(--color)' });
                
                if (!AZauthA2F.value) {
                    PopupLogin.openPopup({ title: 'Erreur', content: 'Code requis.', options: true });
                    return;
                }

                const res = await AZauthClient.login(tempUser, tempPass, AZauthA2F.value);
                
                if (res.error) {
                    PopupLogin.openPopup({ title: 'Erreur', content: res.message, options: true });
                } else {
                    res.type = 'AZauth';
                    await this.saveData(res);
                    PopupLogin.closePopup();
                }
            });
        }

        if(btnCancelA2F) {
            btnCancelA2F.addEventListener('click', () => {
                loginAZauthA2F.style.display = 'none';
                loginAZauth.style.display = 'block';
                AZauthA2F.value = '';
            });
        }
    }

    async saveData(connectionData) {
        console.log("--- DÉBUT SAVEDATA ---");
        try {
            // STEP A
            console.log("SaveData A: Lecture config");
            let configClient = await this.db.readData('configClient') || {};
            
            // STEP B
            console.log("SaveData B: Création/Update data compte");
            // Assurez-vous que connectionData a bien un uuid ou ID
            if(!connectionData.uuid && !connectionData.ID) {
                // Génération ID temporaire pour éviter crash si manquant
                connectionData.ID = connectionData.name; 
            }
            let account = await this.db.createData('accounts', connectionData);
            
            // STEP C
            console.log("SaveData C: Gestion Whitelist");
            let instanceSelect = configClient.instance_select;
            
            // Sécurité si config.getInstanceList n'existe pas ou plante
            let instancesList = [];
            try {
                instancesList = await config.getInstanceList();
            } catch(e) { console.warn("Impossible de lire la liste des instances (ignoré)"); }
            
            configClient.account_selected = account.ID;

            if(instancesList && Array.isArray(instancesList)) {
                for (let instance of instancesList) {
                    if (instance.whitelistActive && instance.name === instanceSelect) {
                        const isWhitelisted = instance.whitelist && instance.whitelist.includes(account.name);
                        if (!isWhitelisted) {
                            let fallback = instancesList.find(i => !i.whitelistActive);
                            if (fallback) {
                                configClient.instance_select = fallback.name;
                                // On vérifie que setStatus est bien importé
                                try { await setStatus(fallback.status); } catch(e){}
                            }
                        }
                    }
                }
            }

            // STEP D
            console.log("SaveData D: Sauvegarde Config Finale");
            await this.db.updateData('configClient', configClient);
            
            // STEP E
            console.log("SaveData E: Mise à jour UI (AddAccount)");
            await addAccount(account);
            
            // STEP F
            console.log("SaveData F: Sélection Compte UI");
            await accountSelect(account);
            
            // STEP G
            console.log("SaveData G: Changement Panel -> Home");
            changePanel('home');
            console.log("--- FIN SAVEDATA (SUCCÈS) ---");

        } catch(err) {
            console.error("CRASH DANS SAVEDATA :", err);
            throw err; // On relance l'erreur pour que tryAutoLogin l'attrape
        }
    }
}
export default Login;