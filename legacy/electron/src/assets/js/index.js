/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

const fs = require("fs");
const path = require("path");

const { ipcRenderer, shell } = require('electron');
const pkg = require('../package.json');
const os = require('os');
import { config, database } from './utils.js';
const nodeFetch = require("node-fetch");

class Splash {
    constructor() {
        this.splash = document.querySelector(".splash");
        this.splashMessage = document.querySelector(".splash-message");
        this.splashAuthor = document.querySelector(".splash-author");
        this.message = document.querySelector(".message");
        this.progress = document.querySelector(".progress");

        document.addEventListener('DOMContentLoaded', async () => {
            let databaseLauncher = new database();
            let configClient = await databaseLauncher.readData('configClient');
            let theme = configClient?.launcher_config?.theme || "auto"
            let isDarkTheme = await ipcRenderer.invoke('is-dark-theme', theme).then(res => res)
            document.body.className = isDarkTheme ? 'dark global' : 'light global';

            if (process.platform == 'win32') ipcRenderer.send('update-window-progress-load')

            this.setRandomBackground();
            this.startAnimation();
        });
    }

    setRandomBackground() {
        try {
            const baseFolder = path.join(__dirname, "assets", "images", "background");

            const subfolders = fs.readdirSync(baseFolder).filter(name =>
                fs.statSync(path.join(baseFolder, name)).isDirectory()
            );

            let images = [];

            for (const folder of subfolders) {
                const folderPath = path.join(baseFolder, folder);
                const files = fs.readdirSync(folderPath);

                const imgs = files.filter(file =>
                    file.endsWith(".jpg") ||
                    file.endsWith(".jpeg") ||
                    file.endsWith(".png") ||
                    file.endsWith(".webp")
                ).map(file => `assets/images/background/${folder}/${file}`);

                images.push(...imgs);
            }

            if (images.length === 0) {
                console.warn("Aucune image trouvée dans background/");
                return;
            }

            const random = images[Math.floor(Math.random() * images.length)];
            const container = document.querySelector(".splash-container");
            container.style.backgroundImage = `url("${random}")`;

        } catch (err) {
            console.error("Erreur lors du chargement du fond aléatoire :", err);
        }
    }

    async startAnimation() {
        let splashes = [
            { "message": "Bienvenue sur PatateLand.", "author": "" },
            { "message": "Rien n'est figé ici.", "author": "" },
            { "message": "Patate un jour, patate toujours.", "author": "" },
            { "message": "Observe bien. Tout a un sens.", "author": "" }
        ];

        let splash = splashes[Math.floor(Math.random() * splashes.length)];
        this.splashMessage.textContent = splash.message;
        this.splashAuthor.children[0].textContent = splash.author;

        await sleep(100);
        document.querySelector("#splash").classList.remove("hidden");
        await sleep(500);
        this.splash.classList.add("opacity");
        await sleep(500);
        this.splash.classList.add("translate");
        this.splashMessage.classList.add("opacity");
        this.splashAuthor.classList.add("opacity");
        this.message.classList.add("opacity");
        await sleep(1000);

        this.checkUpdate();
    }

    async checkUpdate() {

        if (process.env.NODE_ENV === 'dev') {
            return this.maintenanceCheck();
        }

        if (os.platform() !== 'win32') {
            return this.checkUpdateManual();
        }

        this.setStatus(`Recherche de mise à jour...`);

        ipcRenderer.invoke('update-app')
            .catch(err => {
                const msg = err?.message || JSON.stringify(err) || err;
                return this.shutdown(`erreur lors de la recherche de mise à jour :<br>${msg}`);
            });

        ipcRenderer.on('updateAvailable', () => {
            this.setStatus(`Mise à jour disponible !`);
            this.toggleProgress();
            ipcRenderer.send('start-update');
        });

        ipcRenderer.on('error', (event, err) => {
            const msg = err?.message || JSON.stringify(err) || err;
            return this.shutdown(msg);
        });

        ipcRenderer.on('download-progress', (event, progress) => {
            ipcRenderer.send('update-window-progress', { progress: progress.transferred, size: progress.total })
            this.setProgress(progress.transferred, progress.total);
        });

        ipcRenderer.on('update-not-available', () => {
            console.error("Mise à jour non disponible");
            this.maintenanceCheck();
        });
    }

    async checkUpdateManual() {
        this.setStatus(`Recherche de mise à jour...`);

        try {
            const repoURL = pkg.repository.url
                .replace("git+", "")
                .replace(".git", "")
                .replace("https://github.com/", "")
                .split("/");

            const githubAPI = await nodeFetch('https://api.github.com')
                .then(res => res.json());

            const githubAPIRepoURL = githubAPI.repository_url
                .replace("{owner}", repoURL[0])
                .replace("{repo}", repoURL[1]);

            const githubAPIRepo = await nodeFetch(githubAPIRepoURL)
                .then(res => res.json());

            const releases = await nodeFetch(githubAPIRepo.releases_url.replace("{/id}", ''))
                .then(res => res.json());

            const latestRelease = releases[0];
            if (!latestRelease || !latestRelease.tag_name) {

                return this.maintenanceCheck();
            }

            const latestVersion = latestRelease.tag_name.replace(/^v/, '');
            const currentVersion = pkg.version;

            if (this.isNewerVersion(latestVersion, currentVersion)) {
                this.setStatus(`Mise à jour disponible !`);
                return this.dowloadUpdate();
            }

            return this.maintenanceCheck();

        } catch (err) {
            console.error("Erreur lors de la vérification manuelle de mise à jour :", err);
  
            return this.maintenanceCheck();
        }
    }

    isNewerVersion(remote, current) {
        const r = remote.split('.').map(n => parseInt(n, 10) || 0);
        const c = current.split('.').map(n => parseInt(n, 10) || 0);

        for (let i = 0; i < Math.max(r.length, c.length); i++) {
            const rv = r[i] || 0;
            const cv = c[i] || 0;
            if (rv > cv) return true;
            if (rv < cv) return false;
        }
        return false;
    }

    getLatestReleaseForOS(osName, preferredFormat, assets) {
        return assets
            .filter(asset => {
                const name = asset.name.toLowerCase();
                return name.includes(osName) && name.endsWith(preferredFormat);
            })
            .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    }

    async dowloadUpdate() {
        try {
            const repoURL = pkg.repository.url
                .replace("git+", "")
                .replace(".git", "")
                .replace("https://github.com/", "")
                .split("/");

            const githubAPI = await nodeFetch('https://api.github.com')
                .then(res => res.json());

            const githubAPIRepoURL = githubAPI.repository_url
                .replace("{owner}", repoURL[0])
                .replace("{repo}", repoURL[1]);

            const githubAPIRepo = await nodeFetch(githubAPIRepoURL)
                .then(res => res.json());

            const releases = await nodeFetch(githubAPIRepo.releases_url.replace("{/id}", ''))
                .then(res => res.json());

            const latestRelease = releases[0]?.assets || [];
            let latest;

            if (os.platform() == 'darwin')
                latest = this.getLatestReleaseForOS('mac', '.dmg', latestRelease);
            else if (os.platform() == 'linux')
                latest = this.getLatestReleaseForOS('linux', '.appimage', latestRelease);

            if (!latest)
                return this.shutdown("Impossible de trouver la mise à jour pour votre OS.");

            ipcRenderer.send('update-available-notification', {
                title: 'PatateLand - Mise à jour disponible !',
                body: 'Cliquez ici pour télécharger la dernière version.',
                url: latest.browser_download_url
            });

            this.setStatus(`Mise à jour disponible !<br><div class="download-update">Télécharger</div>`);

            document.querySelector(".download-update").addEventListener("click", () => {
                shell.openExternal(latest.browser_download_url);
                return this.shutdown("Téléchargement en cours...");
            });

        } catch (err) {
            const msg = err?.message || JSON.stringify(err) || err;
            return this.shutdown(`Erreur lors de la récupération de la mise à jour :<br>${msg}`);
        }
    }

    // ===== MAINTENANCE (avec whitelist et compte à rebours) =====
    async maintenanceCheck() {
        config.GetConfig().then(async res => {
            if (!res.maintenance) return this.startLauncher();

            if (res.maintenance_end) {
                const endDate = new Date(res.maintenance_end);
                if (!isNaN(endDate.getTime()) && endDate <= new Date()) {
                    return this.startLauncher();
                }
            }

            const isWhitelisted = await this.checkMaintenanceWhitelist(res.maintenance_whitelist);
            if (isWhitelisted) return this.startLauncher();

            return this.startMaintenance(res.maintenance_message, res.maintenance_end);
        }).catch(e => {
            console.error(e);
            return this.shutdown("Aucune connexion internet détectée,<br>veuillez réessayer ultérieurement.");
        });
    }

    async checkMaintenanceWhitelist(whitelist) {
        if (!Array.isArray(whitelist) || whitelist.length === 0) return false;

        try {
            let databaseLauncher = new database();
            let accounts = await databaseLauncher.readAllData('accounts');
            if (!accounts || accounts.length === 0) return false;

            const whitelistLower = whitelist.map(name => name.toLowerCase());
            return accounts.some(account => whitelistLower.includes((account.name || '').toLowerCase()));
        } catch (err) {
            console.error("Erreur lors de la vérification de la whitelist maintenance :", err);
            return false;
        }
    }

    startMaintenance(message, endDateISO) {
        if (!endDateISO) {
            this.setStatus(message);
            return;
        }

        const endDate = new Date(endDateISO);

        if (isNaN(endDate.getTime())) {
            this.setStatus(message);
            return;
        }

        const updateCountdown = () => {
            const now = new Date();
            const diffMs = endDate - now;

            if (diffMs <= 0) {
                clearInterval(this.maintenanceInterval);
                this.maintenanceCheck();
                return;
            }

            const totalSeconds = Math.floor(diffMs / 1000);
            const days = Math.floor(totalSeconds / 86400);
            const hours = Math.floor((totalSeconds % 86400) / 3600);
            const minutes = Math.floor((totalSeconds % 3600) / 60);
            const seconds = totalSeconds % 60;
            const pad = (n) => String(n).padStart(2, '0');

            // Au-delà de 24h restantes : "X jour(s) et HHh MMmin SSs"
            // En dessous de 24h : "HHh MMmin SSs"
            const timeText = `${pad(hours)}h ${pad(minutes)}min ${pad(seconds)}s`;
            const countdownText = days > 0
                ? `${days} jour${days > 1 ? 's' : ''} et ${timeText}`
                : timeText;

            this.setStatus(`${message}<br><span class="maintenance-countdown">Retour estimé dans ${countdownText}</span>`);
        };

        updateCountdown();
        this.maintenanceInterval = setInterval(updateCountdown, 1000);
    }


    startLauncher() {
        this.setStatus(`Démarrage du launcher`);
        ipcRenderer.send('main-window-open');
        ipcRenderer.send('update-window-close');
    }

    shutdown(text) {
        this.setStatus(`${text}<br>Arrêt dans 5s`);
        let i = 4;
        const interval = setInterval(() => {
            this.setStatus(`${text}<br>Arrêt dans ${i--}s`);
            if (i < 0) {
                clearInterval(interval);
                ipcRenderer.send('update-window-close');
            }
        }, 1000);
    }

    setStatus(text) {
        this.message.innerHTML = text;
    }

    toggleProgress() {
        if (this.progress.classList.toggle("show")) this.setProgress(0, 1);
    }

    setProgress(value, max) {
        this.progress.value = value;
        this.progress.max = max;
    }
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey && e.keyCode == 73 || e.keyCode == 123) {
        ipcRenderer.send("update-window-dev-tools");
    }
});

new Splash();