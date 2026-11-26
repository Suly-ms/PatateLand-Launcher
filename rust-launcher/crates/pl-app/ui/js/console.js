// Console de jeu (réglage « Afficher la console »), reprise de l'ancien
// launcher (log.html) : heure et couleur de chaque ligne, compteurs, état du
// jeu, carte du rapport de crash, regroupement des messages log4j.
// Les lignes du jeu sont toujours affichées comme du texte.

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;

const instance = new URLSearchParams(location.search).get('instance') ?? '';
if (instance) document.getElementById('title').textContent = `PatateLand — Console ${instance}`;

const consoleEl = document.getElementById('console');
const scrollBtn = document.getElementById('scroll-btn');
const $ = (id) => document.getElementById(id);

// Au-delà, les plus anciennes lignes sont retirées : la console reste légère
// même après des heures de jeu (l'ancienne gardait tout).
const MAX_LINES = 5000;

let lineCount = 0;
let errorCount = 0;
let warnCount = 0;
let autoScroll = true;

consoleEl.addEventListener('scroll', () => {
    const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 40;
    autoScroll = atBottom;
    scrollBtn.classList.toggle('visible', !atBottom);
});
scrollBtn.addEventListener('click', () => {
    consoleEl.scrollTop = consoleEl.scrollHeight;
    autoScroll = true;
    scrollBtn.classList.remove('visible');
});

function getTime() {
    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function detectType(text) {
    const t = text.toLowerCase();
    if (t.includes('error') || t.includes('erreur') || t.includes('exception') || t.includes('fatal')) return 'error';
    if (t.includes('warn') || t.includes('warning')) return 'warn';
    if (t.includes('started') || t.includes('démarré') || t.includes('ready') || t.includes('success') || t.includes('done')) return 'success';
    return 'info';
}

function updateCounters() {
    $('stat-lines').textContent = lineCount;
    $('stat-errors').textContent = errorCount;
    $('stat-warns').textContent = warnCount;
    $('log-count').textContent = lineCount;
    $('stat-errors').className = `value${errorCount > 0 ? ' error' : ''}`;
}

function trim() {
    while (consoleEl.childElementCount > MAX_LINES) consoleEl.firstElementChild.remove();
}

function addLog(text, forceType = null) {
    if (!text || !text.trim()) return;
    const type = forceType || detectType(text);
    lineCount++;
    if (type === 'error') errorCount++;
    if (type === 'warn') warnCount++;

    const line = document.createElement('div');
    line.className = `log-line log-${type}`;
    const time = document.createElement('span');
    time.className = 'log-time';
    time.textContent = getTime();
    const body = document.createElement('span');
    body.className = 'log-text';
    body.textContent = text;
    line.append(time, body);
    consoleEl.append(line);
    trim();
    updateCounters();
    if (autoScroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ===== Messages log4j (Forge, Mixin) étalés sur plusieurs lignes =====
// <log4j:Event logger="…" level="WARN" thread="main"><log4j:Message><![CDATA[…]]>…
// Regroupés en une seule ligne lisible, comme l'ancien launcher.
let log4jBuffer = null;
const LOG4J_LEVEL_TYPE = { ERROR: 'error', FATAL: 'error', WARN: 'warn', INFO: 'info', DEBUG: 'info', TRACE: 'info' };

function flushLog4j() {
    const raw = log4jBuffer;
    log4jBuffer = null;
    const logger = (raw.match(/logger="([^"]*)"/) || [, '?'])[1];
    const level = (raw.match(/level="([^"]*)"/) || [, 'INFO'])[1].toUpperCase();
    const thread = (raw.match(/thread="([^"]*)"/) || [, ''])[1];
    const cdata = raw.match(/<log4j:Message>\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*<\/log4j:Message>/);
    const message = cdata ? cdata[1].trim() : raw.replace(/<[^>]+>/g, ' ').trim();
    return { text: `[${thread}/${level}]${logger && logger !== '?' ? ` [${logger}]` : ''}: ${message}`, type: LOG4J_LEVEL_TYPE[level] || 'info' };
}

function processIncomingLine(line) {
    if (log4jBuffer === null && line.includes('<log4j:Event')) {
        log4jBuffer = line;
        return line.includes('</log4j:Event>') ? flushLog4j() : null;
    }
    if (log4jBuffer !== null) {
        log4jBuffer += '\n' + line;
        return line.includes('</log4j:Event>') ? flushLog4j() : null;
    }
    return { text: line, type: null };
}

// ===== Rapport de crash =====
async function renderCrashReport(reportPath) {
    lineCount++;
    updateCounters();
    let content = '';
    if (reportPath) {
        try {
            content = await invoke('crash_report_read', { path: reportPath });
        } catch (error) {
            content = `Rapport illisible : ${error}`;
        }
    } else {
        content = "Aucun rapport de crash n'a été écrit par le jeu.";
    }

    const wrapper = document.createElement('div');
    wrapper.className = 'crash-report';
    const header = document.createElement('div');
    header.className = 'crash-report-header';
    const icon = document.createElement('span');
    icon.className = 'crash-report-icon';
    icon.textContent = '💥';
    const title = document.createElement('span');
    title.className = 'crash-report-title';
    title.textContent = 'Le jeu a crashé — rapport disponible';
    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'crash-report-toggle';
    toggleBtn.textContent = 'Afficher';
    header.append(icon, title, toggleBtn);

    const actions = document.createElement('div');
    actions.className = 'crash-report-actions';
    const openBtn = document.createElement('button');
    openBtn.className = 'crash-report-open';
    openBtn.textContent = 'Ouvrir le fichier';
    openBtn.disabled = !reportPath;
    const copyBtn = document.createElement('button');
    copyBtn.className = 'crash-report-copy';
    copyBtn.textContent = 'Copier le rapport';
    actions.append(openBtn, copyBtn);

    const body = document.createElement('pre');
    body.className = 'crash-report-body';
    body.textContent = content;
    wrapper.append(header, actions, body);

    toggleBtn.addEventListener('click', () => {
        const open = wrapper.classList.toggle('open');
        toggleBtn.textContent = open ? 'Masquer' : 'Afficher';
        if (open && autoScroll) consoleEl.scrollTop = consoleEl.scrollHeight;
    });
    if (reportPath) openBtn.addEventListener('click', () => invoke('crash_report_open', { path: reportPath }).catch(() => {}));
    copyBtn.addEventListener('click', () => {
        navigator.clipboard
            .writeText(content)
            .then(() => {
                copyBtn.textContent = 'Copié !';
                setTimeout(() => (copyBtn.textContent = 'Copier le rapport'), 1500);
            })
            .catch(() => {});
    });

    consoleEl.append(wrapper);
    if (autoScroll) consoleEl.scrollTop = consoleEl.scrollHeight;
}

// ===== État du jeu =====
function setStatus(status) {
    const dot = $('status-dot');
    const text = $('status-text');
    if (status === 'running') {
        dot.className = 'status-dot running';
        text.textContent = 'En jeu';
        addLog('Minecraft lancé avec succès !', 'success');
    } else if (status === 'closed') {
        dot.className = 'status-dot stopped';
        text.textContent = 'Fermé';
        addLog("Minecraft s'est fermé.", 'system');
    } else if (status === 'error') {
        dot.className = 'status-dot stopped';
        text.textContent = 'Erreur';
        addLog('Une erreur est survenue.', 'error');
    } else if (status === 'crashed') {
        dot.className = 'status-dot crashed';
        text.textContent = 'Crash';
    }
}

listen('game-log', ({ payload }) => {
    if (payload.instance !== instance || typeof payload.line !== 'string') return;
    for (const raw of payload.line.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        const result = processIncomingLine(line);
        if (result) addLog(result.text, result.type);
    }
});
let started = false;
listen('console-event', ({ payload: { instance: from, event: payload } }) => {
    if (from !== instance) return;
    if (payload.type === 'menu_reached' && !started) {
        started = true;
        setStatus('running');
    } else if (payload.type === 'exited') {
        if (payload.crash) {
            setStatus('crashed');
            renderCrashReport(payload.crash.report ?? null);
        } else {
            setStatus('closed');
        }
    }
});
listen('game-finished', ({ payload }) => {
    if (payload.instance === instance && payload.error) setStatus('error');
});

$('btn-minimize').addEventListener('click', () => getCurrentWindow().minimize());
$('btn-close').addEventListener('click', () => getCurrentWindow().close());
$('btn-copy').addEventListener('click', () => navigator.clipboard.writeText(consoleEl.innerText).catch(() => {}));
$('btn-clear').addEventListener('click', () => {
    consoleEl.replaceChildren();
    lineCount = 0;
    errorCount = 0;
    warnCount = 0;
    updateCounters();
});

addLog('Console PatateLand initialisée', 'system');
addLog('En attente des logs de Minecraft...', 'info');
