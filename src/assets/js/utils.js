/**
 * @author Luuxis
 * Luuxis License v1.0
 */

// --- MODULES NODE.JS (via require) ---
const { ipcRenderer } = require('electron');
const { Status } = require('minecraft-java-core');
const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');

// --- MODULES LOCAUX (via import) ---
import config from './utils/config.js';
import database from './utils/database.js';
import logger from './utils/logger.js';
import popup from './utils/popup.js';
import { skin2D } from './utils/skin.js';
import slider from './utils/slider.js';

// --- FONCTIONS UTILS ---

async function setBackground(theme) {
    const db = new database();
    if (typeof theme === 'undefined') {
        const configClient = await db.readData('configClient');
        let themeId = configClient?.launcher_config?.theme || "auto";
        theme = await ipcRenderer.invoke('is-dark-theme', themeId);
    }

    const body = document.body;
    body.className = theme ? 'dark global' : 'light global';
    
    // --- CORRECTION DU CHEMIN ---
    // process.cwd() renvoie la racine du projet, c'est le plus sûr.
    const assetsPath = path.join(process.cwd(), 'src', 'assets', 'images', 'background');
    
    console.log(`[Background] Chemin des images : ${assetsPath}`); // Pour vérifier dans la console

    let backgroundUrl = null;

    try {
        // Easter Egg (1 chance sur 200)
        if (Math.random() < 0.005) {
            try {
                const eePath = path.join(assetsPath, 'easterEgg');
                if (fs.existsSync(eePath)) {
                    const files = fs.readdirSync(eePath);
                    if(files.length > 0) {
                        const rnd = files[Math.floor(Math.random() * files.length)];
                        // Pour le CSS, on utilise le chemin relatif
                        backgroundUrl = `url(./assets/images/background/easterEgg/${rnd})`;
                    }
                }
            } catch(e) {}
        }

        // Chargement normal
        if (!backgroundUrl) {
            try {
                const folder = theme ? 'dark' : 'light';
                const bgPath = path.join(assetsPath, folder);
                
                if (fs.existsSync(bgPath)) {
                    const files = fs.readdirSync(bgPath);
                    if(files.length > 0) {
                        const rnd = files[Math.floor(Math.random() * files.length)];
                        backgroundUrl = `linear-gradient(#00000080, #00000080), url(./assets/images/background/${folder}/${rnd})`;
                    } else {
                        console.warn(`[Background] Aucun fichier trouvé dans : ${bgPath}`);
                    }
                } else {
                    console.warn(`[Background] Dossier introuvable : ${bgPath}`);
                }
            } catch(e) { console.error("Erreur lecture dossier:", e); }
        }

    } catch (err) {
        console.error("Erreur globale background:", err);
    }

    // Application
    if (backgroundUrl) {
        body.style.backgroundImage = backgroundUrl;
    } else {
        // Fallback propre
        body.style.backgroundImage = 'none';
        body.style.backgroundColor = theme ? '#111' : '#eee';
    }
    
    body.style.backgroundSize = 'cover';
    body.style.backgroundPosition = 'center';
}

function changePanel(id) {
    const panel = document.querySelector(`.${id}`);
    const active = document.querySelector(`.active`);
    if (active) active.classList.remove("active");
    if (panel) panel.classList.add("active");
}

async function appdata() {
    return await ipcRenderer.invoke('appData');
}

async function addAccount(data) {
    const accountsList = document.querySelector('.accounts-list');
    if (!accountsList) return;

    const existing = document.getElementById(data.ID || data.uuid);
    if (existing) existing.remove();

    let skin = false;
    if (data?.profile?.skins?.[0]?.base64) {
        try {
            skin = await new skin2D().creatHeadTexture(data.profile.skins[0].base64);
        } catch(e) {}
    }

    const div = document.createElement("div");
    div.classList.add("account");
    div.id = data.ID || data.uuid;
    
    div.innerHTML = `
        <div class="profile-image" ${skin ? 'style="background-image: url(' + skin + ');"' : ''}></div>
        <div class="profile-infos">
            <div class="profile-pseudo"></div>
            <div class="profile-uuid">${data.uuid || 'ID inconnu'}</div>
        </div>
        <div class="delete-profile" id="${data.ID}">
            <div class="icon-account-delete delete-profile-icon"></div>
        </div>
    `;
    
    div.querySelector('.profile-pseudo').textContent = data.name || 'Joueur';
    return accountsList.appendChild(div);
}

async function accountSelect(data) {
    if (!data.ID && !data.uuid) return;
    const account = document.getElementById(data.ID || data.uuid);
    const activeAccount = document.querySelector('.account-select');

    if (activeAccount) activeAccount.classList.remove('account-select');
    
    if (account) {
        account.classList.add('account-select');
        if (data?.profile?.skins?.[0]?.base64) {
            headplayer(data.profile.skins[0].base64).catch(() => {});
        }
    }
}

async function headplayer(skinBase64) {
    const skin = await new skin2D().creatHeadTexture(skinBase64);
    const head = document.querySelector(".player-head");
    if (head) head.style.backgroundImage = `url(${skin})`;
}

async function setStatus(opt) {
    const nameEl = document.querySelector('.server-status-name');
    const statusEl = document.querySelector('.server-status-text');
    const playersEl = document.querySelector('.status-player-count .player-count');
    const countContainer = document.querySelector('.status-player-count');

    const safeText = (el, text) => { if(el) el.innerHTML = text; }
    const safeClass = (el, method, className) => { if(el) el.classList[method](className); }

    if (!opt) {
        safeClass(statusEl, 'add', 'red');
        safeText(statusEl, 'Ferme - 0 ms');
        safeClass(countContainer, 'add', 'red');
        safeText(playersEl, '0');
        return;
    }

    const { ip, port, nameServer } = opt;
    safeText(nameEl, nameServer);

    try {
        const status = new Status(ip, port);
        const statusServer = await status.getStatus();

        if (statusServer && !statusServer.error) {
            safeClass(statusEl, 'remove', 'red');
            safeClass(countContainer, 'remove', 'red');
            safeText(statusEl, `En ligne - ${statusServer.ms} ms`);
            safeText(playersEl, statusServer.playersConnect);
        } else {
            throw "Offline";
        }
    } catch (err) {
        safeClass(statusEl, 'add', 'red');
        safeText(statusEl, 'Ferme - 0 ms');
        safeClass(countContainer, 'add', 'red');
        safeText(playersEl, '0');
    }
}

export {
    appdata, changePanel, config, database, logger, popup,
    setBackground, skin2D, addAccount, accountSelect,
    slider as Slider, pkg, setStatus
};