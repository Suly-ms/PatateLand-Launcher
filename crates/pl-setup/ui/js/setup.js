// Installateur PatateLand : écrans de la maquette validée, branchés sur les
// commandes Rust (src/install.rs).

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const $ = (id) => document.getElementById(id);
const SCREENS = ['welcome', 'options', 'progress', 'done'];

const options = { dir: '', desktop: true, start_menu: true, autostart: false, lite: false, remove_old: true };
let autoMode = false;
let installing = false;

function go(name) {
    const index = SCREENS.indexOf(name);
    document.querySelectorAll('.screen').forEach((s) => s.classList.toggle('active', s.id === `screen-${name}`));
    document.querySelectorAll('.steps span').forEach((s, n) => s.classList.toggle('on', n <= index));
}

function renderOptions() {
    $('dir').textContent = options.dir;
    $('dir').title = options.dir;
    $('opt-desktop').classList.toggle('on', options.desktop);
    $('opt-start-menu').classList.toggle('on', options.start_menu);
    $('opt-autostart').classList.toggle('on', options.autostart);
    $('opt-remove-old').classList.toggle('on', options.remove_old);
    $('task-old').classList.toggle('hidden', !(options.has_old && options.remove_old));
    document.querySelectorAll('.mode').forEach((m) => m.classList.toggle('on', m.dataset.lite === String(options.lite)));
}

function toggle(id, key) {
    $(id).addEventListener('click', () => {
        options[key] = !options[key];
        renderOptions();
    });
}

const TASKS = () => [...document.querySelectorAll('#tasks li')];

function showProgress({ step, ratio }) {
    const percent = Math.round(ratio * 100);
    $('fill').style.width = `${percent}%`;
    $('pct').textContent = `${percent} %`;
    const tasks = TASKS();
    tasks.forEach((li, n) => (li.className = n < step || ratio >= 1 ? 'done' : n === step ? 'doing' : ''));
    $('task').textContent = tasks[step]?.textContent ?? '';
}

async function install() {
    if (installing) return;
    installing = true;
    $('close').disabled = true;
    $('error').classList.add('hidden');
    $('tip').classList.remove('hidden');
    $('fill').classList.remove('failed');
    $('progress-title').textContent = 'Installation…';
    showProgress({ step: 0, ratio: 0 });
    go('progress');
    try {
        await invoke('install', { options });
        showProgress({ step: 4, ratio: 1 });
        setTimeout(() => go('done'), 600);
        // Mise à jour automatique : le launcher est relancé tout seul.
        if (autoMode) setTimeout(() => invoke('finish', { launch: true }), 1800);
    } catch (error) {
        const failed = TASKS().find((li) => li.className === 'doing');
        if (failed) failed.className = 'failed';
        $('fill').classList.add('failed');
        $('progress-title').textContent = "L'installation n'a pas abouti";
        $('task').textContent = 'Erreur';
        $('error-text').textContent = String(error);
        $('error').classList.remove('hidden');
        $('tip').classList.add('hidden');
    } finally {
        installing = false;
        $('close').disabled = false;
    }
}

async function start() {
    listen('setup-progress', (e) => showProgress(e.payload));

    const info = await invoke('info');
    Object.assign(options, {
        dir: info.dir,
        desktop: info.desktop,
        start_menu: info.start_menu,
        autostart: info.autostart,
        lite: info.lite,
        // Bascule (lancé par l'ancien launcher) : désinstallé. Installation à la
        // main (bêta) : proposé mais pas coché, l'ancien reste en secours.
        remove_old: info.auto,
        has_old: !!info.old_launcher,
    });
    autoMode = info.auto;
    if (info.old_launcher) {
        // L'ancien launcher est remplacé : on le dit plutôt que « indépendant ».
        $('fact-old').textContent = 'Remplace';
        $('fact-old-text').textContent = "l'ancien launcher";
        $('opt-remove-old').classList.remove('hidden');
        $('opt-remove-old').lastChild.textContent = `Désinstaller l'ancien launcher PatateLand (${info.old_launcher})`;
    }
    const size = (mb) => `${mb.toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Mo`;
    $('fact-download').textContent = size(info.download_mb);
    $('fact-disk').textContent = `≈ ${size(Math.ceil(info.disk_mb))}`;
    if (info.update) {
        $('welcome-title').textContent = 'Mise à jour';
        const from = info.previous_version ? ` (version ${info.previous_version})` : '';
        $('welcome-lead').textContent = `PatateLand est déjà installé sur ce PC${from}. Il va être mis à jour en version ${info.version}. Tes comptes et tes réglages sont conservés.`;
        document.querySelectorAll('.install-btn').forEach((b) => (b.textContent = 'Mettre à jour'));
        $('done-title').textContent = 'PatateLand est à jour !';
    }
    if (!info.complete) {
        $('incomplete').classList.remove('hidden');
        document.querySelectorAll('.install-btn').forEach((b) => (b.disabled = true));
    }
    renderOptions();
    if (autoMode && info.complete) install();
}

document.querySelectorAll('[data-go]').forEach((b) => b.addEventListener('click', () => go(b.dataset.go)));
document.querySelectorAll('.install-btn').forEach((b) => b.addEventListener('click', install));
$('retry').addEventListener('click', install);
toggle('opt-desktop', 'desktop');
toggle('opt-start-menu', 'start_menu');
toggle('opt-autostart', 'autostart');
toggle('opt-remove-old', 'remove_old');
document.querySelectorAll('.mode').forEach((m) =>
    m.addEventListener('click', () => {
        options.lite = m.dataset.lite === 'true';
        renderOptions();
    }),
);
$('dir-pick').addEventListener('click', async () => {
    const dir = await invoke('pick_dir', { current: options.dir }).catch(() => null);
    if (dir) {
        options.dir = dir;
        renderOptions();
    }
});
$('opt-launch').addEventListener('click', () => {
    const on = $('opt-launch').classList.toggle('on');
    $('finish').textContent = on ? 'Jouer' : 'Fermer';
});
$('finish').addEventListener('click', () => invoke('finish', { launch: $('opt-launch').classList.contains('on') }));
$('close').addEventListener('click', () => invoke('quit'));
$('minimize').addEventListener('click', () => invoke('minimize'));
// Pas de menu contextuel ni de rechargement par F5 dans un installateur.
document.addEventListener('contextmenu', (e) => e.preventDefault());
document.addEventListener('keydown', (e) => {
    if (e.key === 'F5' || (e.ctrlKey && e.key.toLowerCase() === 'r')) e.preventDefault();
});

start().catch((error) => {
    $('incomplete').textContent = String(error);
    $('incomplete').classList.remove('hidden');
});
