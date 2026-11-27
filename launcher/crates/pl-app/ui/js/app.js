// Interface du launcher PatateLand.
//
// Règles : tout texte venant du serveur ou du joueur est affiché avec
// textContent (jamais interprété comme du HTML). Seules les actualités sont
// insérées en HTML, après nettoyage côté Rust (pl_engine::news).
//
// Les écrans Paramètres et Connexion, le bandeau d'avis et l'encart
// partenaire reprennent à l'identique ceux de l'ancien launcher.

import Slider from './slider.js';
import { initFriends, setFriendsAccount } from './friends.js';

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);

const BACKGROUNDS = { dark: 7, light: 8 };
const NEWS_DELAY_MS = 12000;
const STATUS_DELAY_MS = 15000;
/// Actualités rechargées toutes les 3 minutes (ancien launcher).
const NEWS_REFRESH_MS = 3 * 60 * 1000;

const state = {
    boot: null,
    settings: null,
    accounts: [],
    selectedAccount: null,
    instances: [],
    news: [],
    newsIndex: 0,
    newsTimer: null,
    statusTimer: null,
    maintenanceTimer: null,
    busy: false,
    /// Instances en cours (installation ou jeu).
    running: new Set(),
    ramSlider: null,
};

// Citations de l'écran de démarrage de l'ancien launcher.
const QUOTES = [
    'Bienvenue sur PatateLand.',
    "Rien n'est figé ici.",
    'Patate un jour, patate toujours.',
    'Observe bien. Tout a un sens.',
];
const REVIEW_URL = 'https://patateland.wstr.fr/review';

// ---------- Outils ----------

function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}

let toastTimer = null;
function toast(message, kind = 'info') {
    const box = $('toast');
    box.textContent = message;
    box.className = `toast ${kind}`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => box.classList.add('hidden'), 5000);
}

async function call(command, args = {}) {
    try {
        return await invoke(command, args);
    } catch (error) {
        dialog('Erreur', [String(error)]);
        throw error;
    }
}

/// Pop-up de l'ancien launcher : message en rouge pour les erreurs (comme
/// `color: 'red'`), sinon dans la couleur du texte.
function dialog(title, paragraphs, actions = [{ label: 'OK' }], { error = /^(Erreur|Crash)/.test(title) } = {}) {
    $('dialog-title').textContent = title;
    $('dialog-body').classList.toggle('error', error);
    $('dialog-body').replaceChildren(...paragraphs.map((p) => el('p', '', p)));
    $('dialog-actions').replaceChildren(
        ...actions.map((action) => {
            const button = el('button', action.primary === false ? 'popup-button secondary' : 'popup-button', action.label);
            button.addEventListener('click', () => {
                $('dialog').classList.add('hidden');
                action.run?.();
            });
            return button;
        }),
    );
    $('dialog').classList.remove('hidden');
}

function showPanel(name) {
    document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('active', p.id === `panel-${name}`));
    if (name === 'home') placeReview();
}

/// Onglets des paramètres (mêmes identifiants que l'ancien launcher).
function showTab(name) {
    document.querySelectorAll('#panel-settings .nav-settings-btn[data-tab]').forEach((b) =>
        b.classList.toggle('active-settings-BTN', b.dataset.tab === name),
    );
    document.querySelectorAll('#panel-settings .container-settings').forEach((t) =>
        t.classList.toggle('active-container-settings', t.id === `${name}-tab`),
    );
    // Le curseur de RAM a besoin de sa largeur à l'écran pour se placer.
    if (name === 'jeu') requestAnimationFrame(initRamSlider);
    if (name === 'personnalisation') loadPacks();
    if (name === 'stockage') loadStorage();
}

function openSettings(tab = 'account') {
    showPanel('settings');
    showTab(tab);
}

// ---------- Apparence ----------

function currentTheme() {
    const theme = state.settings?.theme ?? 'auto';
    if (theme !== 'auto') return theme;
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

/// Thème, mode léger et image de fond. Comme l'ancien launcher, l'image
/// n'est tirée qu'au démarrage et quand le thème change : avant, chaque
/// réglage enregistré en tirait une nouvelle, et pendant son chargement les
/// blocs translucides paraissaient opaques sur un fond uni.
function applyAppearance() {
    const theme = currentTheme();
    document.body.classList.toggle('dark', theme === 'dark');
    document.body.classList.toggle('light', theme === 'light');
    document.body.classList.toggle('lite', !!state.settings?.lite_mode);
    if (state.backgroundTheme === theme) return;
    state.backgroundTheme = theme;
    const n = 1 + Math.floor(Math.random() * BACKGROUNDS[theme]);
    // Comme l'ancien launcher : un fond secret, une fois sur deux cents.
    const image = Math.random() < 0.005 ? 'img/bg/easter.jpg' : `img/bg/${theme}/${n}.jpg`;
    $('background').style.backgroundImage = `url("${image}")`;
}

// ---------- Comptes (cartes identiques à l'ancien launcher) ----------

function selectedAccount() {
    return state.accounts.find((a) => a.id === state.selectedAccount) ?? null;
}

function setAccounts(view) {
    state.accounts = view.accounts;
    state.selectedAccount = view.selected;
    renderAccounts();
}

const STATUS_LABEL = { unverified: 'Non vérifié (service injoignable)', relogin: 'Reconnexion nécessaire' };

function renderAccounts() {
    const account = selectedAccount();
    $('player-name').textContent = account ? account.name : 'Se connecter';
    $('player-head').src = account ? account.head : 'img/icon.png';

    const cards = state.accounts.map((a) => {
        const card = el('div', `account${a.id === state.selectedAccount ? ' account-select' : ''}`);
        const head = el('img', 'profile-image');
        head.src = a.head;
        head.alt = a.name;
        card.append(head, el('div', 'profile-name', a.name));
        if (STATUS_LABEL[a.status]) {
            const status = el('div', `profile-status ${a.status}`, STATUS_LABEL[a.status]);
            if (a.detail) status.title = a.detail;
            card.append(status);
        }
        const remove = el('div', 'delete-profile');
        remove.append(el('div', 'icon-account-delete delete-profile-icon'));
        remove.title = 'Supprimer ce compte';
        remove.addEventListener('click', (event) => {
            event.stopPropagation();
            dialog('Supprimer le compte ?', [`Le compte ${a.name} sera retiré de ce launcher.`], [
                { label: 'Annuler', primary: false },
                { label: 'Supprimer', run: async () => { setAccounts(await call('remove_account', { id: a.id })); await reloadInstances(); } },
            ]);
        });
        card.append(remove);
        card.addEventListener('click', async () => {
            setAccounts(await call('select_account', { id: a.id }));
            await reloadInstances();
        });
        return card;
    });

    const add = el('div', 'account');
    const addIcon = el('div', 'add-profile');
    addIcon.append(el('div', 'icon-account-add'));
    add.append(addIcon, el('div', 'add-text-profile', 'Ajouter un compte'));
    add.addEventListener('click', () => openLogin(true));
    $('accounts-list').replaceChildren(...cards, add);

    renderReview();
    checkMaintenance();
    setFriendsAccount(account);
}

/// Écran de connexion de l'ancien launcher : la méthode affichée dépend du
/// serveur (`online` de /config). La croix n'existe que si on vient des
/// paramètres (comme avant).
function openLogin(fromSettings) {
    const mode = state.boot?.auth_mode ?? 'unknown';
    const screen = { azauth: 'login-azauth', microsoft: 'login-microsoft', offline: 'login-offline' }[mode] ?? 'login-offline';
    for (const id of ['login-azauth', 'login-microsoft', 'login-offline', 'login-a2f']) {
        $(id).classList.toggle('hidden', id !== screen);
    }
    $('login-back').classList.toggle('hidden', !fromSettings);
    if (mode === 'unknown') toast('Serveur PatateLand injoignable : seul un compte hors-ligne peut être ajouté pour le moment.');
    showPanel('login');
}

async function afterLogin(view, message) {
    setAccounts(view);
    await reloadInstances();
    toast(message);
    showPanel('home');
}

async function loginAzauth(withCode) {
    const button = withCode ? $('a2f-submit') : $('az-submit');
    if (!withCode && (!$('az-email').value || !$('az-password').value)) {
        dialog('Erreur', ['Veuillez remplir tous les champs.']);
        return;
    }
    if (withCode && !$('az-code').value) {
        dialog('Erreur', ['Veuillez entrer le code A2F.']);
        return;
    }
    button.disabled = true;
    try {
        const result = await call('login_azauth', {
            email: $('az-email').value,
            password: $('az-password').value,
            code: withCode ? $('az-code').value : null,
        });
        if (result.two_factor) {
            $('login-azauth').classList.add('hidden');
            $('login-a2f').classList.remove('hidden');
            $('az-code').focus();
            return;
        }
        $('az-password').value = '';
        $('az-code').value = '';
        $('login-a2f').classList.add('hidden');
        $('login-azauth').classList.remove('hidden');
        await afterLogin(result.accounts, 'Connecté !');
    } catch {
        // Erreur déjà affichée par call().
    } finally {
        button.disabled = false;
    }
}

async function loginMicrosoft() {
    const button = $('ms-submit');
    button.disabled = true;
    try {
        await afterLogin(await call('login_microsoft'), 'Compte Microsoft ajouté !');
    } catch {
        // Erreur (ou annulation) déjà affichée par call().
    } finally {
        button.disabled = false;
    }
}

async function addOffline() {
    const name = $('offline-name').value.trim();
    if (name.length < 3) {
        dialog('Erreur', ['Votre pseudo doit faire au moins 3 caractères.']);
        return;
    }
    if (/\s/.test(name)) {
        dialog('Erreur', ["Votre pseudo ne doit pas contenir d'espaces."]);
        return;
    }
    const view = await call('add_offline', { name });
    $('offline-name').value = '';
    await afterLogin(view, `Compte ${name} ajouté.`);
}

// ---------- Instances et statut du serveur ----------

function selectedInstance() {
    return state.instances.find((i) => i.name === state.settings?.selected_instance) ?? null;
}

async function reloadInstances() {
    state.instances = await call('instances');
    renderInstance();
}

/// Description affichée dans l'info-bulle « ? » (textes de l'ancien launcher
/// quand le serveur n'en donne pas).
const INSTANCE_DESCRIPTIONS = {
    event: 'Instance dédiée aux événements spéciaux et temporaires.',
    extra: 'Instance avec des fonctionnalités et du contenu supplémentaire.',
    opti: 'Instance optimisée pour de meilleures performances, idéale pour les configurations modestes.',
};

/// Instances visibles par ce joueur : comme l'ancien launcher, celles
/// réservées à d'autres joueurs ne sont pas affichées.
function visibleInstances() {
    return state.instances.filter((i) => i.allowed);
}

function renderInstance() {
    const instance = selectedInstance();
    $('instance-btn').textContent = instance ? instance.name : (state.boot?.remote_ok ? 'Aucune' : 'Indisponible');
    // Une seule instance : pas de bouton de choix (comme l'ancien).
    $('instance-btn').classList.toggle('hidden', visibleInstances().length === 1);
    $('status-name').textContent = instance ? `PatateLand · ${instance.name}` : 'PatateLand';
    refreshStatus();
}

function openInstancePicker() {
    const list = $('instance-list');
    const instances = visibleInstances();
    if (!instances.length) {
        list.replaceChildren(el('div', 'instances-empty', "Aucune instance : le serveur PatateLand n'a pas pu être joint."));
    } else {
        list.replaceChildren(
            ...instances.map((i) => {
                // Hors connexion, seule une instance déjà installée est jouable.
                const offline = !state.boot.remote_ok && !i.installed;
                const active = i.name === state.settings.selected_instance;
                const item = el('div', `instance-elements${active ? ' active-instance' : ''}${offline ? ' locked' : ''}`);
                const name = el('span', 'instance-name', i.name);
                if (state.running.has(i.name)) name.append(' ', el('span', 'instance-running-badge', 'En cours'));
                const desc = offline
                    ? 'Pas encore installée sur ce PC : connexion au serveur nécessaire.'
                    : i.description || INSTANCE_DESCRIPTIONS[i.name.trim().toLowerCase()] || 'Aucune description disponible pour cette instance.';
                const info = el('div', 'instance-info-icon', '?');
                info.addEventListener('click', (e) => e.stopPropagation());
                item.append(name, info, el('div', 'instance-info-tooltip', desc));
                if (offline) return item;
                item.addEventListener('click', async () => {
                    state.settings = await call('select_instance', { name: i.name });
                    $('instance-modal').classList.add('hidden');
                    renderInstance();
                });
                return item;
            }),
        );
    }
    $('instance-modal').classList.remove('hidden');
}

async function refreshStatus() {
    clearTimeout(state.statusTimer);
    const instance = selectedInstance();
    const text = $('status-text');
    const players = $('status-players');
    if (!instance) {
        text.textContent = state.boot?.remote_ok ? 'Aucune instance' : 'Serveur PatateLand injoignable';
        text.classList.add('offline');
        players.classList.add('offline');
    } else {
        try {
            const status = await invoke('server_status', { instance: instance.name });
            const online = !!status?.online;
            text.textContent = online ? `En ligne - ${status.latency_ms} ms` : 'Ferme - 0 ms';
            text.classList.toggle('offline', !online);
            players.classList.toggle('offline', !online);
            $('players-count').textContent = online ? `${status.players}` : '0';
        } catch {
            text.textContent = 'Statut indisponible';
        }
    }
    // Rafraîchi seulement quand la fenêtre est visible.
    state.statusTimer = setTimeout(() => {
        if (document.visibilityState === 'visible') refreshStatus();
    }, STATUS_DELAY_MS);
}

// ---------- Actualités (un seul minuteur, arrêté quand la fenêtre est cachée) ----------

/// Date en deux lignes (jour, puis mois), comme l'ancien launcher. Sans date
/// valide (message d'erreur, liste vide) : la date du jour, comme avant.
function setNewsDate(raw) {
    let date = raw ? new Date(raw) : new Date();
    if (Number.isNaN(date.getTime())) date = new Date();
    $('news-day').textContent = String(date.getDate());
    $('news-month').textContent = date.toLocaleDateString('fr-FR', { month: 'long' });
}

/// Message sans actualité (erreur ou liste vide), en texte simple.
function newsMessage(title, lines) {
    $('news-headline').textContent = title;
    setNewsDate(null);
    const p = el('p');
    lines.forEach((line, i) => {
        if (i) p.append(el('br'));
        p.append(line);
    });
    $('news-body').replaceChildren(p);
    $('news-nav').classList.add('hidden');
}

/// Barre de progression sous les points : relancée à chaque actualité.
function restartNewsProgress() {
    const fill = $('news-progress');
    fill.classList.remove('run');
    void fill.offsetWidth;
    if (state.news.length > 1 && document.visibilityState === 'visible') fill.classList.add('run');
}

function renderNews(animate = false) {
    const items = state.news;
    if (!items.length) {
        newsMessage('Aucune actualité disponible', ['Vous pourrez suivre ici toutes les news relatives au serveur.']);
        return;
    }
    const item = items[state.newsIndex];
    $('news-headline').textContent = item.title;
    setNewsDate(item.date);
    // HTML déjà nettoyé côté Rust (balises de mise en forme uniquement).
    const body = $('news-body');
    body.innerHTML = item.html;
    if (item.author) {
        const author = el('p', 'news-author', 'Auteur - ');
        author.append(el('span', '', item.author));
        body.append(author);
    }
    body.scrollTop = 0;
    if (animate) {
        const card = $('news-card');
        card.classList.remove('slide-in');
        void card.offsetWidth;
        card.classList.add('slide-in');
    }
    $('news-nav').classList.toggle('hidden', items.length < 2);
    $('news-prev').disabled = state.newsIndex === 0;
    $('news-next').disabled = state.newsIndex === items.length - 1;
    $('news-dots').replaceChildren(
        ...items.map((_, i) => {
            const dot = el('span', `news-dot${i === state.newsIndex ? ' active' : ''}`);
            dot.addEventListener('click', () => showNews(i));
            return dot;
        }),
    );
}

function showNews(index) {
    if (!state.news.length) return;
    state.newsIndex = (index + state.news.length) % state.news.length;
    renderNews(true);
    scheduleNews();
}

function scheduleNews() {
    clearTimeout(state.newsTimer);
    restartNewsProgress();
    if (state.news.length > 1 && document.visibilityState === 'visible') {
        state.newsTimer = setTimeout(() => showNews(state.newsIndex + 1), NEWS_DELAY_MS);
    }
}

/// Rechargement périodique : la liste n'est redessinée que si elle a changé
/// (l'ancien revenait à la première actualité à chaque fois).
async function refreshNews() {
    if (document.visibilityState !== 'visible') return;
    try {
        const fresh = await invoke('news');
        if (JSON.stringify(fresh) === JSON.stringify(state.news)) return;
        state.news = fresh;
        state.newsIndex = Math.min(state.newsIndex, Math.max(fresh.length - 1, 0));
        renderNews();
        scheduleNews();
    } catch {
        // Hors connexion : on garde les actualités affichées.
    }
}

async function loadNews() {
    clearInterval(state.newsRefreshTimer);
    state.newsRefreshTimer = setInterval(refreshNews, NEWS_REFRESH_MS);
    try {
        state.news = await invoke('news');
    } catch {
        state.news = [];
        newsMessage('Erreur', ['Impossible de contacter le serveur des news.', 'Merci de vérifier votre configuration.']);
        return;
    }
    state.newsIndex = 0;
    renderNews();
    scheduleNews();
}

// ---------- Paramètres (identiques à l'ancien launcher) ----------

async function saveSettings(patch) {
    try {
        state.settings = await invoke('update_settings', { patch });
        applyAppearance();
    } catch (error) {
        dialog('Erreur', [String(error)]);
    }
    renderSettings();
}

function currentMemory() {
    return state.settings.memory ?? state.boot.system.recommended;
}

/// Curseur à deux poignées de l'ancien launcher : bornes de 0,5 Go à 80 % de
/// la RAM du PC, par pas de 0,5 Go.
function initRamSlider() {
    const sys = state.boot.system;
    const slider = $('memory-slider');
    slider.setAttribute('min', '0.5');
    slider.setAttribute('max', String(Math.max(sys.max_allowed_gb, sys.recommended.min_gb + 0.5)));
    slider.setAttribute('step', '0.5');
    if (state.ramSlider) {
        state.ramSlider.refresh(currentMemory().min_gb, currentMemory().max_gb);
        return;
    }
    state.ramSlider = new Slider(slider, currentMemory().min_gb, currentMemory().max_gb);
    // Enregistré au relâchement, pas à chaque mouvement.
    state.ramSlider.on('release', (min, max) => saveSettings({ memory: { min_gb: min, max_gb: max } }));
}

function renderSettings() {
    const s = state.settings;
    const sys = state.boot.system;

    // JEU
    $('total-ram').textContent = `${sys.ram_gb} Go`;
    $('free-ram').textContent = `${sys.free_gb} Go`;
    $('recommended-ram').textContent = `${sys.recommended.min_gb} Go mini / ${sys.recommended.max_gb} Go maxi`;
    $('ram-low-warning').classList.toggle('hidden', !sys.low_ram);
    if (state.ramSlider) state.ramSlider.refresh(currentMemory().min_gb, currentMemory().max_gb);
    $('width').value = s.width;
    $('height').value = s.height;
    $('fullscreen-toggle').checked = s.fullscreen;
    $('java-path-txt').textContent = s.java_path ?? 'Java fourni par le launcher';
    $('java-path-input').value = s.java_path ?? 'Utiliser la version de java livre avec le launcher';

    // LAUNCHER
    $('crash-report-toggle').checked = s.send_crash_reports;
    $('console-toggle').checked = s.show_console;
    $('start-minimized-toggle').checked = s.start_minimized;
    $('max-files').value = s.download_concurrency;
    document.querySelectorAll('[data-close]').forEach((b) => b.classList.toggle('active-close', b.dataset.close === s.close_behavior));
    document.querySelectorAll('[data-theme]').forEach((b) => b.classList.toggle('active-theme', b.dataset.theme === s.theme));
    document.querySelectorAll('[data-display]').forEach((b) => b.classList.toggle('active-display', b.dataset.display === (s.lite_mode ? 'lite' : 'normal')));
    // État réellement enregistré dans Windows, pas une copie du réglage.
    invoke('auto_launch_enabled')
        .then((enabled) => {
            $('autolaunch-toggle').checked = enabled;
            $('start-minimized-box').classList.toggle('hidden', !enabled);
        })
        .catch(() => {});

    // COMPTES : notifications sociales (système d'amis)
    $('friend-request-notif-toggle').checked = s.notify_friend_requests;
    $('friend-message-notif-toggle').checked = s.notify_friend_messages;
}

/// Boutons − / + des champs numériques, comme l'ancien launcher.
function stepNumber(button) {
    const input = $(button.dataset.target);
    const step = Number(input.step) || 1;
    const min = Number(input.min) || 0;
    const max = Number(input.max) || 99999;
    let value = Number(input.value) || 0;
    value = button.classList.contains('plus') ? Math.min(value + step, max) : Math.max(value - step, min);
    input.value = value;
    input.dispatchEvent(new Event('change'));
}

// ---------- Resource packs et shaders ----------

async function loadPacks() {
    for (const kind of ['resource', 'shader']) {
        try {
            renderPacks(kind, await invoke('packs_list', { kind }));
        } catch (error) {
            $(`packs-${kind}`).replaceChildren(el('div', kind === 'resource' ? 'rp-empty-msg' : 'sp-empty-msg', String(error)));
        }
    }
}

function renderPacks(kind, packs) {
    const box = $(`packs-${kind}`);
    if (!packs.length) {
        box.replaceChildren(el('div', kind === 'resource' ? 'rp-empty-msg' : 'sp-empty-msg', kind === 'resource' ? 'Aucun resource pack installé.' : 'Aucun shader installé.'));
        return;
    }
    box.replaceChildren(
        ...packs.map((p) => {
            const row = el('div', 'rp-item');
            const remove = el('div', kind === 'resource' ? 'rp-item-delete rp-delete-btn' : 'sp-delete-btn', 'Supprimer');
            remove.addEventListener('click', () =>
                dialog('Supprimer ce pack ?', [p.name], [
                    { label: 'Annuler', primary: false },
                    { label: 'Supprimer', run: async () => renderPacks(kind, await call('packs_remove', { kind, name: p.name })) },
                ]),
            );
            row.append(el('div', 'rp-item-name', p.name), remove);
            return row;
        }),
    );
}

// ---------- Stockage et quarantaine ----------

const STORAGE_CATEGORIES = [
    ['logs', 'Logs', '#3498db'],
    ['accounts', 'Comptes', '#9b59b6'],
    ['shared', 'Ressources partagées', '#2ecc71'],
    ['runtime', 'Runtime Java', '#f39c12'],
    ['instances', 'Instances', '#e74c3c'],
    ['other', 'Autre', '#95a5a6'],
];

function formatSize(bytes) {
    if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} Go`;
    if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} Mo`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} Ko`;
    return `${bytes} o`;
}

async function loadStorage() {
    $('storage-total').textContent = 'Total : calcul…';
    let view;
    try {
        view = await invoke('storage_overview');
    } catch (error) {
        $('storage-total').textContent = String(error);
        return;
    }
    $('storage-bar').replaceChildren(
        ...STORAGE_CATEGORIES.filter(([key]) => view.overview[key] > 0).map(([key, , color]) => {
            const part = el('div', 'storage-bar-segment');
            part.style.width = `${((view.overview[key] / view.total) * 100).toFixed(2)}%`;
            part.style.background = color;
            return part;
        }),
    );
    $('storage-legend').replaceChildren(
        ...STORAGE_CATEGORIES.map(([key, label, color]) => {
            const row = el('div', 'storage-legend-item');
            const dot = el('span', 'storage-legend-dot');
            dot.style.background = color;
            row.append(dot, document.createTextNode(`${label} — ${formatSize(view.overview[key])}`));
            return row;
        }),
    );
    $('storage-total').textContent = `Total : ${formatSize(view.total)}`;

    const box = $('quarantine');
    if (!view.quarantine.length) {
        box.replaceChildren(el('div', 'rp-empty-msg', 'Aucun fichier en quarantaine.'));
        return;
    }
    box.replaceChildren(
        ...view.quarantine.map((q) => {
            const row = el('div', 'rp-item');
            const restore = el('div', 'rp-restore-btn', 'Restaurer');
            restore.addEventListener('click', async () => {
                await call('quarantine_restore', { id: q.id });
                toast('Fichier remis à sa place.');
                loadStorage();
            });
            const name = el('div', 'rp-item-name', `${q.instance} / ${q.original}`);
            name.title = q.reason;
            row.append(name, restore);
            return row;
        }),
    );
}

function confirmClear(title, text, command) {
    dialog(title, [text], [
        { label: 'Annuler', primary: false },
        {
            label: 'Vider',
            run: async () => {
                const locked = await call(command);
                toast(locked ? `${locked} élément(s) en cours d'utilisation laissé(s) en place.` : 'Nettoyage terminé.');
                loadStorage();
            },
        },
    ]);
}

// ---------- Bandeau d'avis (masquable par compte, comme l'ancien launcher) ----------

function renderReview() {
    const account = selectedAccount();
    const dismissed = state.settings?.review_dismissed_accounts ?? [];
    $('review').classList.toggle('hidden', !account || dismissed.includes(account.id));
    placeReview();
}

/// Aligné sur le bord droit de la barre du bas, comme l'ancien launcher.
function placeReview() {
    const rect = $('bar').getBoundingClientRect();
    if (rect.width) $('review').style.right = `${window.innerWidth - rect.right}px`;
}

async function dismissReview(openSite) {
    const account = selectedAccount();
    if (openSite) call('open_url', { url: REVIEW_URL }).catch(() => {});
    $('review').classList.add('hidden');
    if (account) state.settings = await call('dismiss_review', { account: account.id });
}

// ---------- Maintenance (liste blanche et compte à rebours) ----------

/// « 2 jours et 05h 03min 10s » (format de l'ancien launcher).
function maintenanceDelay(left) {
    const pad = (n) => String(n).padStart(2, '0');
    const days = Math.floor(left / 86400);
    const time = `${pad(Math.floor((left % 86400) / 3600))}h ${pad(Math.floor((left % 3600) / 60))}min ${pad(left % 60)}s`;
    return `${days > 0 ? `${days} jour${days > 1 ? 's' : ''} et ` : ''}${time}`;
}

/// Joueur autorisé pendant une maintenance : bandeau avec le message et
/// « Fin dans … » (comme l'ancien launcher).
function showMaintenanceBanner(m, end) {
    clearInterval(state.maintenanceBannerTimer);
    const banner = $('maintenance-banner');
    $('maintenance-banner-text').textContent = (m.message || 'Maintenance en cours.').replace(/<br\s*\/?>/gi, ' ');
    const countdown = $('maintenance-banner-countdown');
    banner.classList.remove('hidden');
    if (!end || Number.isNaN(end.getTime())) {
        countdown.textContent = '';
        return;
    }
    const tick = () => {
        const left = Math.floor((end - new Date()) / 1000);
        if (left <= 0) {
            clearInterval(state.maintenanceBannerTimer);
            banner.classList.add('hidden');
            return;
        }
        countdown.textContent = `Fin dans ${maintenanceDelay(left)}`;
    };
    tick();
    state.maintenanceBannerTimer = setInterval(tick, 1000);
}

function checkMaintenance() {
    clearInterval(state.maintenanceTimer);
    clearInterval(state.maintenanceBannerTimer);
    const m = state.boot?.maintenance;
    const end = m?.end ? new Date(m.end) : null;
    const over = end && !Number.isNaN(end.getTime()) && end <= new Date();
    const player = selectedAccount()?.name?.toLowerCase();
    const whitelisted = !!player && (m?.whitelist ?? []).some((n) => n.toLowerCase() === player);
    const blocked = !!m && !over && !whitelisted;
    $('maintenance').classList.toggle('hidden', !blocked);
    $('maintenance-banner').classList.add('hidden');
    if (m && !over && whitelisted) showMaintenanceBanner(m, end);
    if (!blocked) return;

    // Le message du serveur peut contenir des <br> : affiché en texte simple.
    $('maintenance-message').textContent = (m.message || 'Le serveur est en maintenance.').replace(/<br\s*\/?>/gi, '\n');
    const countdown = $('maintenance-countdown');
    const tick = () => {
        if (!end || Number.isNaN(end.getTime())) {
            countdown.textContent = '';
            return;
        }
        const left = Math.floor((end - new Date()) / 1000);
        if (left <= 0) {
            clearInterval(state.maintenanceTimer);
            location.reload();
            return;
        }
        countdown.textContent = `Retour estimé dans ${maintenanceDelay(left)}`;
    };
    tick();
    state.maintenanceTimer = setInterval(tick, 1000);
}

// ---------- JOUER ----------

// ---------- Écran de lancement ----------
//
// Quatre étapes, comme demandé : Préparation (Java, Minecraft, Forge),
// Vérification (fichiers déjà présents), Téléchargement (fichiers manquants),
// Lancement (démarrage de Minecraft jusqu'au menu). Les données viennent du
// moteur : événements « game » et compteurs « progress » (4 fois par seconde).

const STEPS = { PREPARE: 0, VERIFY: 1, DOWNLOAD: 2, LAUNCH: 3 };
const launch = { step: 0, pct: [0, 0, 0, 0], lastBytes: 0, lastTime: 0, speed: 0, hideTimer: null };

function renderLaunch() {
    document.querySelectorAll('#launch-card .launch-step').forEach((el, i) => {
        const done = i < launch.step || launch.pct[i] >= 100;
        const active = i === launch.step && !done;
        el.classList.toggle('done', done);
        el.classList.toggle('active', active);
        el.querySelector('b').textContent = active && launch.pct[i] > 0 ? `${Math.floor(launch.pct[i])}%` : '';
        el.querySelector('.launch-step-bar span').style.width = `${done ? 100 : launch.pct[i]}%`;
    });
}

function setLaunch(step, pct, message, detail = '') {
    if (step !== null) launch.step = step;
    if (pct !== null) launch.pct[launch.step] = Math.max(0, Math.min(100, pct));
    if (message) $('launch-message').textContent = message;
    $('launch-detail').textContent = detail;
    renderLaunch();
}

/// État final de la carte : succès (vert) ou erreur (rouge).
function endLaunch(kind, message) {
    $('launch-icon').className = kind === 'ok' ? 'launch-icon ok' : 'launch-icon error';
    $('launch-icon').textContent = kind === 'ok' ? '✓' : '✕';
    $('launch-message').textContent = message;
    $('launch-detail').textContent = '';
    clearTimeout(launch.hideTimer);
    launch.hideTimer = setTimeout(() => $('launch-card').classList.add('hidden'), kind === 'ok' ? 2500 : 5000);
}

function showLaunchCard() {
    clearTimeout(launch.hideTimer);
    Object.assign(launch, { step: 0, pct: [0, 0, 0, 0], lastBytes: 0, lastTime: 0, speed: 0 });
    $('launch-icon').className = 'launch-spinner';
    $('launch-icon').textContent = '';
    setLaunch(STEPS.PREPARE, 5, 'Préparation du lancement…');
    $('launch-card').classList.remove('hidden');
    // Le bandeau d'avis passerait sous la carte.
    $('review').classList.add('hidden');
}

/// `running` : fenêtre rouverte pendant une partie (pas d'écran de lancement).
function setBusy(busy, { running = false } = {}) {
    state.busy = busy;
    $('play').disabled = busy;
    $('instance-btn').disabled = busy;
    $('play-title').textContent = busy ? (running ? 'En jeu' : 'Lancement en cours') : 'Choisissez votre instance';
    if (busy && !running) showLaunchCard();
    if (!busy) renderReview();
}

async function play() {
    if (state.busy) return;
    if (!selectedAccount()) {
        openLogin(false);
        return;
    }
    setBusy(true);
    try {
        await invoke('play');
    } catch (error) {
        setBusy(false);
        $('launch-card').classList.add('hidden');
        dialog('Erreur', [String(error)]);
    }
}

function onGameEvent(event) {
    switch (event.type) {
        case 'step': {
            const label = event.label;
            if (label.startsWith('Lancement')) setLaunch(STEPS.LAUNCH, 5, 'Lancement de Minecraft…');
            else if (label.startsWith('Forge')) setLaunch(null, null, `Installation de ${label}…`);
            else if (label.startsWith('Fichiers')) setLaunch(null, null, `${label}…`);
            else setLaunch(null, null, `Préparation de ${label}…`);
            break;
        }
        case 'offline':
            toast(`Hors connexion : ${event.detail}.`);
            break;
        case 'installed':
            // Rien à télécharger : l'étape est simplement validée.
            launch.pct = [100, 100, 100, launch.pct[3]];
            setLaunch(STEPS.LAUNCH, 10, 'Fichiers prêts, démarrage de Java…');
            break;
        case 'java_started':
            setLaunch(STEPS.LAUNCH, 50, 'Démarrage de Minecraft…');
            break;
        case 'menu_reached':
            setLaunch(STEPS.LAUNCH, 100, 'Bon jeu !');
            endLaunch('ok', 'Bon jeu !');
            $('play-title').textContent = 'En jeu';
            break;
        case 'exited':
            invoke('take_last_exit').catch(() => {});
            if (event.crash) {
                const lines = ["Le jeu s'est arrêté de manière inattendue."];
                if (event.crash.report) lines.push('Un rapport de crash a été enregistré.');
                if (event.crash.queued) lines.push("Il est prêt à être transmis à l'équipe dès que le service du site existera.");
                const actions = [{ label: 'Fermer', primary: false }];
                if (event.crash.report) {
                    // Le rapport de cette partie : l'instance qui a planté n'est
                    // pas forcément celle sélectionnée (menu de l'icône,
                    // plusieurs parties en même temps).
                    actions.push({ label: 'Ouvrir le rapport', run: () => call('crash_report_open', { path: event.crash.report }) });
                }
                dialog('Crash de Minecraft', lines, actions);
            }
            break;
        default:
            break;
    }
}

function onProgress(p) {
    if (!state.busy || launch.step === STEPS.LAUNCH) return;
    const n = (v) => v.toLocaleString('fr-FR');
    if (p.total > 0 && p.done < p.total) {
        // Débit lissé, pour un chiffre lisible.
        const now = performance.now();
        if (launch.lastTime) {
            const instant = ((p.done - launch.lastBytes) / (now - launch.lastTime)) * 1000;
            launch.speed = launch.speed ? launch.speed * 0.7 + instant * 0.3 : instant;
        }
        launch.lastBytes = p.done;
        launch.lastTime = now;
        const mb = (b) => (b / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
        const speed = launch.speed > 0 ? ` · ${mb(launch.speed)} Mo/s` : '';
        setLaunch(STEPS.DOWNLOAD, (p.done / p.total) * 100, 'Téléchargement des fichiers…', `${mb(p.done)} / ${mb(p.total)} Mo${speed}`);
    } else if (p.checked_total > 0 && p.checked_done < p.checked_total) {
        setLaunch(STEPS.VERIFY, (p.checked_done / p.checked_total) * 100, 'Vérification des fichiers…', `${n(p.checked_done)} / ${n(p.checked_total)} fichiers`);
    }
}

function onGameFinished({ instance, error }) {
    state.running.delete(instance);
    // Une autre partie continue (menu de l'icône) : l'écran reste « En jeu ».
    if (state.running.size) {
        $('play-title').textContent = `En jeu · ${[...state.running].join(', ')}`;
        if (error) dialog('Erreur', [error]);
        return;
    }
    setBusy(false);
    if (error) {
        endLaunch('error', 'Le lancement a échoué.');
        dialog('Erreur', [error]);
    } else if (!$('launch-card').classList.contains('hidden') && $('launch-icon').className === 'launch-spinner') {
        $('launch-card').classList.add('hidden');
    }
}

// ---------- Événements ----------

function bindEvents() {
    $('win-min').addEventListener('click', () => invoke('window_minimize'));
    $('win-max').addEventListener('click', () => invoke('window_toggle_maximize'));
    $('win-close').addEventListener('click', () => invoke('window_close'));
    window.addEventListener('resize', placeReview);

    // Aucun lien ne doit faire naviguer la fenêtre : ouverture dans le navigateur,
    // si le launcher l'autorise (domaines PatateLand et réseaux connus).
    document.addEventListener('click', (event) => {
        const link = event.target.closest('a[href]');
        if (!link) return;
        event.preventDefault();
        if (link.href.startsWith('https://')) call('open_url', { url: link.href }).catch(() => {});
    });
    document.querySelectorAll('[data-url]').forEach((b) => b.addEventListener('click', () => call('open_url', { url: b.dataset.url }).catch(() => {})));

    // Comme l'ancien launcher : avec un compte du site, la tête ouvre le profil.
    $('player').addEventListener('click', () => {
        const account = selectedAccount();
        if (account?.kind === 'AZauth' && state.boot?.auth_site) {
            call('open_url', { url: `${state.boot.auth_site}/profile` }).catch(() => {});
        } else {
            openSettings('account');
        }
    });
    // Ctrl+W ferme le launcher, comme avant.
    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.key.toLowerCase() === 'w') invoke('window_close');
    });

    $('review-open').addEventListener('click', () => dismissReview(true));
    $('review-close').addEventListener('click', () => dismissReview(false));

    $('instance-btn').addEventListener('click', openInstancePicker);
    document.querySelectorAll('[data-close-modal]').forEach((b) => b.addEventListener('click', () => b.closest('.modal, .instance-popup').classList.add('hidden')));
    $('play').addEventListener('click', play);
    $('news-prev').addEventListener('click', () => showNews(state.newsIndex - 1));
    $('news-next').addEventListener('click', () => showNews(state.newsIndex + 1));
    $('open-settings').addEventListener('click', () => openSettings('account'));

    // Connexion
    $('login-back').addEventListener('click', () => openSettings('account'));
    $('az-submit').addEventListener('click', () => loginAzauth(false));
    $('a2f-submit').addEventListener('click', () => loginAzauth(true));
    $('a2f-cancel').addEventListener('click', () => {
        $('login-a2f').classList.add('hidden');
        $('login-azauth').classList.remove('hidden');
    });
    $('ms-submit').addEventListener('click', loginMicrosoft);
    $('offline-submit').addEventListener('click', () => addOffline().catch(() => {}));
    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' || !$('panel-login').classList.contains('active')) return;
        if (!$('login-azauth').classList.contains('hidden')) loginAzauth(false);
        else if (!$('login-a2f').classList.contains('hidden')) loginAzauth(true);
        else if (!$('login-offline').classList.contains('hidden')) addOffline().catch(() => {});
    });

    // Paramètres : navigation
    document.querySelectorAll('#panel-settings .nav-settings-btn[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
    $('save').addEventListener('click', () => {
        showTab('account');
        showPanel('home');
    });

    // JEU
    $('apply-recommended-ram').addEventListener('click', () => saveSettings({ memory: state.boot.system.recommended }));
    document.querySelectorAll('#panel-settings .number-btn').forEach((b) => b.addEventListener('click', () => stepNumber(b)));
    $('width').addEventListener('change', () => saveSettings({ width: Number($('width').value) }));
    $('height').addEventListener('change', () => saveSettings({ height: Number($('height').value) }));
    $('size-reset').addEventListener('click', () => saveSettings({ width: 1280, height: 720 }));
    $('fullscreen-toggle').addEventListener('change', () => saveSettings({ fullscreen: $('fullscreen-toggle').checked }));
    $('java-path-set').addEventListener('click', async () => {
        state.settings = await call('pick_java');
        renderSettings();
    });
    $('java-path-reset').addEventListener('click', async () => {
        state.settings = await call('reset_java');
        renderSettings();
    });

    // LAUNCHER
    $('autolaunch-toggle').addEventListener('change', async () => {
        try {
            state.settings = await call('set_auto_launch', { enabled: $('autolaunch-toggle').checked });
        } finally {
            renderSettings();
        }
    });
    $('start-minimized-toggle').addEventListener('change', () => saveSettings({ start_minimized: $('start-minimized-toggle').checked }));
    $('crash-report-toggle').addEventListener('change', () => saveSettings({ send_crash_reports: $('crash-report-toggle').checked }));
    $('console-toggle').addEventListener('change', () => saveSettings({ show_console: $('console-toggle').checked }));
    document.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => saveSettings({ close_behavior: b.dataset.close })));
    $('max-files').addEventListener('change', () => saveSettings({ download_concurrency: Number($('max-files').value) }));
    $('max-files-reset').addEventListener('click', () => saveSettings({ download_concurrency: 5 }));
    $('test-notification').addEventListener('click', () => call('test_notification').then(() => toast('Notification envoyée.')).catch(() => {}));
    document.querySelectorAll('[data-theme]').forEach((b) => b.addEventListener('click', () => saveSettings({ theme: b.dataset.theme })));
    document.querySelectorAll('[data-display]').forEach((b) =>
        b.addEventListener('click', async () => {
            await saveSettings({ lite_mode: b.dataset.display === 'lite' });
            toast(`Mode d'affichage enregistré : ${b.dataset.display === 'lite' ? 'léger' : 'normal'} au prochain démarrage du launcher.`);
        }),
    );

    // COMPTES : notifications sociales
    $('friend-request-notif-toggle').addEventListener('change', () => saveSettings({ notify_friend_requests: $('friend-request-notif-toggle').checked }));
    $('friend-message-notif-toggle').addEventListener('change', () => saveSettings({ notify_friend_messages: $('friend-message-notif-toggle').checked }));

    // STOCKAGE
    $('storage-clear-logs').addEventListener('click', () =>
        confirmClear('Vider les logs ?', "Vider les logs de l'instance actuelle ? Assure-toi qu'aucune partie n'est en cours.", 'clear_logs'),
    );
    $('storage-clear-cache').addEventListener('click', () =>
        confirmClear('Vider le cache ?', "Vider le cache Minecraft (assets, bibliothèques, versions) ? Le prochain lancement sera plus long. Assure-toi qu'aucune partie n'est en cours.", 'clear_cache'),
    );

    // PERSONNALISATION et dossiers
    document.querySelectorAll('[data-pack-add]').forEach((b) =>
        b.addEventListener('click', async () => renderPacks(b.dataset.packAdd, await call('packs_import', { kind: b.dataset.packAdd }))),
    );
    document.querySelectorAll('[data-open-folder]').forEach((b) =>
        b.addEventListener('click', () => call('open_instance_folder', { folder: b.dataset.openFolder }).catch(() => {})),
    );

    // Fenêtre cachée : plus de minuteurs (actualités, statut).
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
            scheduleNews();
            refreshStatus();
        } else {
            clearTimeout(state.newsTimer);
            clearTimeout(state.statusTimer);
        }
    });
}

// ---------- Mises à jour du launcher ----------

/// Comme l'ancien launcher : au démarrage, une mise à jour trouvée est
/// installée tout de suite (Windows). Ne bloque jamais plus de 8 s si GitHub
/// ne répond pas.
async function startupUpdate(boot) {
    if (boot.running.length) return false;
    const timeout = new Promise((resolve) => setTimeout(() => resolve(null), 8000));
    const update = await Promise.race([invoke('check_update').catch(() => null), timeout]);
    if (!update) return false;
    if (!update.install) {
        offerDownload(update);
        return false;
    }
    $('splash-loading').textContent = `Mise à jour disponible ! Téléchargement de la version ${update.version}…`;
    const stop = await listen('update-progress', (e) => {
        const { done, total } = e.payload;
        const mb = (b) => (b / 1048576).toLocaleString('fr-FR', { maximumFractionDigits: 1 });
        $('splash-loading').textContent = done >= total
            ? 'Installation de la mise à jour…'
            : `Mise à jour ${update.version} : ${mb(done)} / ${mb(total)} Mo (${Math.floor((done / total) * 100)} %)`;
    });
    try {
        // Le launcher se ferme ici ; l'installateur prend le relais.
        await invoke('apply_update');
        return true;
    } catch (error) {
        stop();
        dialog('Erreur', [`Mise à jour impossible pour le moment : ${error}`]);
        return false;
    }
}

/// Notes de version (fichier NOUVEAUTES.txt à la publication), en texte.
function updateLines(update, first) {
    const notes = (update.notes || '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 12);
    return notes.length ? [first, 'Nouveautés :', ...notes.map((l) => (l.startsWith('-') ? l : `- ${l}`))] : [first];
}

/// Mac et Linux : téléchargement manuel, comme l'ancien launcher.
function offerDownload(update) {
    dialog('Mise à jour disponible !', updateLines(update, `La version ${update.version} du launcher est disponible.`), [
        { label: 'Plus tard', primary: false },
        { label: 'Télécharger', run: () => invoke('apply_update').catch((e) => dialog('Erreur', [String(e)])) },
    ]);
}

/// Trouvée pendant que le launcher est ouvert (vérification toutes les 10 min).
function onUpdateAvailable(update) {
    if (state.updateOffered === update.version) return;
    state.updateOffered = update.version;
    if (!update.install) return offerDownload(update);
    dialog('Mise à jour disponible !', updateLines(update, `La version ${update.version} du launcher est prête (${update.size_mb.toLocaleString('fr-FR')} Mo).`), [
        { label: 'Plus tard', primary: false },
        {
            label: 'Installer maintenant',
            run: async () => {
                toast('Téléchargement de la mise à jour…');
                // Progression dans le message (le launcher se ferme ensuite).
                const stop = await listen('update-progress', (e) => {
                    const { done, total } = e.payload;
                    toast(done >= total ? 'Installation de la mise à jour…' : `Téléchargement de la mise à jour : ${Math.floor((done / total) * 100)} %`);
                });
                await invoke('apply_update').catch((e) => {
                    stop();
                    dialog('Erreur', [String(e)]);
                });
            },
        },
    ]);
}

// ---------- Démarrage ----------

async function start() {
    $('splash-quote').textContent = QUOTES[Math.floor(Math.random() * QUOTES.length)];
    // Mac : boutons de fenêtre natifs (voir window.rs), les nôtres sont masqués.
    if (/Mac/.test(navigator.platform || navigator.userAgent)) document.body.classList.add('mac');
    bindEvents();
    initFriends({ dialog });
    listen('game', (e) => onGameEvent(e.payload));
    listen('progress', (e) => onProgress(e.payload));
    listen('game-finished', (e) => onGameFinished(e.payload));
    // Partie lancée depuis le menu de l'icône.
    listen('game-started', (e) => {
        state.running.add(e.payload);
        if (!state.busy) setBusy(true);
    });
    listen('open-settings', () => openSettings('jeu'));
    listen('accounts-changed', () => call('refresh_accounts').then(setAccounts).then(reloadInstances).catch(() => {}));

    const boot = await call('bootstrap');
    listen('update-available', (e) => onUpdateAvailable(e.payload));
    if (await startupUpdate(boot)) return;
    state.boot = boot;
    state.settings = boot.settings;
    state.instances = boot.instances;
    state.running = new Set(boot.running);
    applyAppearance();
    setAccounts({ accounts: boot.accounts, selected: boot.selected_account });
    renderSettings();
    renderInstance();

    const banner = $('banner');
    if (!boot.remote_ok && boot.cached_at) {
        const date = new Date(boot.cached_at * 1000).toLocaleString('fr-FR', { dateStyle: 'long', timeStyle: 'short' });
        banner.textContent = `Serveur PatateLand injoignable : informations du ${date} (copie enregistrée sur ce PC). Tu peux jouer aux instances déjà installées.`;
        banner.classList.remove('hidden');
    } else if (!boot.remote_ok) {
        banner.textContent = 'Serveur PatateLand injoignable et aucune information enregistrée : une première connexion est nécessaire pour installer une instance.';
        banner.classList.remove('hidden');
    }

    // Fenêtre rouverte pendant une partie, ou après un crash survenu fenêtre fermée.
    if (boot.running.length) {
        setBusy(true, { running: true });
        $('play-title').textContent = `En jeu · ${boot.running.join(', ')}`;
    }
    const lastExit = await invoke('take_last_exit').catch(() => null);
    if (lastExit) onGameEvent(lastExit);
    $('splash').classList.add('done');
    if (boot.updated_to) toast(`PatateLand a été mis à jour en version ${boot.updated_to}.`);

    loadNews();
    if (boot.accounts.length) {
        // Vérification des comptes en arrière-plan, sans bloquer l'écran.
        const refreshed = call('refresh_accounts').then(setAccounts).then(reloadInstances).catch(() => {});
        if (boot.autoplay) refreshed.then(play);
        // « Paramètres » choisi dans le menu de l'icône, fenêtre fermée.
        if (boot.open_settings) openSettings('jeu');
    } else {
        // Comme l'ancien launcher : sans compte, on arrive sur la connexion.
        openLogin(false);
    }
}

// Même en cas d'erreur au démarrage, l'écran de démarrage laisse place au launcher.
start().catch(() => {}).finally(() => $('splash').classList.add('done'));
