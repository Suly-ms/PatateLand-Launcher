// Console de jeu (réglage « Afficher la console »), comme celle de l'ancien
// launcher. Les lignes sont affichées en texte, jamais interprétées.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const instance = new URLSearchParams(location.search).get('instance') ?? '';
const log = document.getElementById('log');
const status = document.getElementById('status');
document.getElementById('title').textContent = `Console ${instance}`;

// Au-delà, les plus anciennes lignes sont retirées : la console reste légère
// même après des heures de jeu.
const MAX_LINES = 5000;

function append(line) {
    const atBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
    const row = document.createElement('div');
    row.textContent = line;
    if (/\bERROR\b|Exception|FATAL/.test(line)) row.className = 'error';
    else if (/\bWARN/.test(line)) row.className = 'warn';
    log.append(row);
    while (log.childElementCount > MAX_LINES) log.firstElementChild.remove();
    if (atBottom) log.scrollTop = log.scrollHeight;
}

function setStatus(text, kind) {
    status.textContent = text;
    status.className = `status ${kind}`;
}

listen('game-log', ({ payload }) => {
    if (payload.instance === instance) append(payload.line);
});
listen('game-finished', ({ payload }) => {
    if (payload.instance !== instance) return;
    if (payload.error) setStatus('erreur', 'error');
});
listen('game', ({ payload }) => {
    if (payload.type !== 'exited') return;
    if (payload.crash) {
        setStatus('crash', 'crashed');
        append('');
        append('===== Le jeu s\'est arrêté de manière inattendue =====');
        if (payload.crash.report) append(`Rapport de crash : ${payload.crash.report}`);
    } else {
        setStatus('fermé', 'closed');
    }
});

document.getElementById('copy').addEventListener('click', () => navigator.clipboard.writeText(log.innerText));
document.getElementById('clear').addEventListener('click', () => log.replaceChildren());
document.getElementById('close').addEventListener('click', () => getCurrentWindow().close());
