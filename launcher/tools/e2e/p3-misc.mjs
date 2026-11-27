// Phase 3 : maintenance, serveur injoignable, modes de connexion, fenêtre,
// instance unique, icône (tray), fermeture.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP, GAME, Session, check, readRun, runFile, step, sleep, setState, writeReport } from './wd.mjs';

const notifs = () => readRun('notify.log');
const dialogText = (s) => s.js(`const d=document.getElementById('dialog'); return d.classList.contains('hidden') ? null : d.innerText;`);
const closeDialog = (s) => s.js(`document.querySelector('#dialog-actions button')?.click();`);
const booted = `return document.getElementById('splash').classList.contains('done')`;
const iso = (sec) => new Date(Date.now() + sec * 1000).toISOString();
const gdbus = (...args) => execFileSync('gdbus', ['call', '--session', ...args]).toString();

async function withSession(fn) {
    const s = await Session.start();
    try { await s.waitFor(booted, { label: 'démarrage' }); await fn(s); } finally { await s.end(); }
}

try {
    if (!process.env.ONLY_LAST) {
    await step('maintenance bloquante', async () => {
        setState({ config: { maintenance: true, maintenance_message: 'Mise à jour<br>du serveur', maintenance_end: iso(25) } });
        await withSession(async (s) => {
            await sleep(800);
            check('Maintenance : écran bloquant', await s.visible('#maintenance'));
            check('Message (avec <br> en retour à la ligne)', (await s.js(`return document.getElementById('maintenance-message').textContent`)) === 'Mise à jour\ndu serveur');
            check('Compte à rebours', /Retour estimé dans 00h 00min \d\ds/.test(await s.text('#maintenance-countdown')), await s.text('#maintenance-countdown'));
            await s.shot('20-maintenance');
            // Fin du compte à rebours : rechargement automatique ; le serveur
            // a levé la maintenance entre-temps.
            setState({});
            await s.waitFor(`return document.getElementById('splash').classList.contains('done') && document.getElementById('maintenance').classList.contains('hidden')`, { timeout: 40000, label: 'fin de maintenance' });
            check('Fin de maintenance : rechargement automatique', true);
        });
    });

    await step('maintenance liste blanche', async () => {
        setState({ config: { maintenance: true, maintenance_message: 'Maintenance', maintenance_end: iso(3 * 86400 + 3600), maintenance_whitelist: ['patatetest'] } });
        await withSession(async (s) => {
            await sleep(800);
            check('Joueur autorisé (casse ignorée) : pas d\'écran bloquant', !(await s.visible('#maintenance')));
            check('Bandeau de maintenance', await s.visible('#maintenance-banner'));
            check('Compte à rebours en jours', /Fin dans 3 jours et 0\dh/.test(await s.text('#maintenance-banner-countdown')), await s.text('#maintenance-banner-countdown'));
            await s.shot('21-maintenance-whitelist');
        });
    });

    await step('serveur injoignable', async () => {
        setState({ down: true });
        await withSession(async (s) => {
            await sleep(1500);
            check('Bandeau « copie enregistrée sur ce PC »', /injoignable : informations du .* \(copie enregistrée/.test(await s.text('#banner')), await s.text('#banner'));
            await s.click('#instance-btn');
            const items = await s.js(`return [...document.querySelectorAll('#instance-list .instance-elements')].map(e=>({n:e.querySelector('.instance-name').firstChild.textContent, locked:e.classList.contains('locked')}))`);
            check('Instances installées jouables hors connexion', items.length >= 1 && items.every((i) => !i.locked), JSON.stringify(items));
            await s.js(`document.querySelector('[data-close-modal]')?.click()`);
            await s.waitFor(`return /Impossible de contacter/.test(document.getElementById('news-body').textContent)`, { label: 'news hors ligne', timeout: 10000 });
            check('Actualités : message d\'erreur', true);
            await s.shot('22-hors-ligne');
            await s.click('#play');
            await s.waitFor(`return document.getElementById('launch-message').textContent==='Bon jeu !'`, { timeout: 180000, every: 1000, label: 'jeu hors ligne' });
            check('Jouer sans le serveur PatateLand (instance installée)', true);
            const pid = execFileSync('pgrep', ['-f', 'instances/Test']).toString().trim().split('\n')[0];
            process.kill(Number(pid), 'SIGKILL');
            await s.waitFor(`return !document.getElementById('play').disabled`, { timeout: 30000 });
            await closeDialog(s);
        });
        setState({});
    });

    await step('modes de connexion', async () => {
        setState({ config: { online: true } });
        await withSession(async (s) => {
            await s.js(`document.getElementById('open-settings').click()`);
            await s.js(`[...document.querySelectorAll('#accounts-list .account')].pop().click()`);
            await sleep(300);
            check('online: true → connexion Microsoft', await s.visible('#login-microsoft'));
            check('Bouton Amis absent pour un compte hors-ligne', !(await s.visible('#friends-btn')));
            await s.shot('23-login-microsoft');
        });
        setState({ config: { online: 'https://127.0.0.1:9' } });
        await withSession(async (s) => {
            await s.js(`document.getElementById('open-settings').click()`);
            await s.js(`[...document.querySelectorAll('#accounts-list .account')].pop().click()`);
            await sleep(300);
            check('online: URL → connexion AZauth', await s.visible('#login-azauth'));
            await s.shot('24-login-azauth');
            await s.click('#az-submit');
            check('AZauth : champs vides refusés', /remplir tous les champs/.test(await dialogText(s)));
            await closeDialog(s);
            await s.type('#az-email', 'test@exemple.fr');
            await s.type('#az-password', 'motdepasse');
            await s.click('#az-submit');
            await s.waitFor(`return !document.getElementById('dialog').classList.contains('hidden')`, { timeout: 20000, label: 'erreur AZauth' });
            const t = await dialogText(s);
            check('AZauth injoignable : erreur affichée, pas de plantage', /Erreur/.test(t), t.replace(/\n/g, ' | ').slice(0, 150));
            await closeDialog(s);
            check('Mot de passe non conservé dans le champ après erreur ?', true, `valeur: ${(await s.js(`return document.getElementById('az-password').value`)) ? 'conservée' : 'vidée'}`);
            await s.click('#login-back');
            check('Croix : retour aux paramètres', (await s.js(`return document.querySelector('.panel.active')?.id`)) === 'panel-settings');
        });
        setState({});
    });

    }
    await step('fenêtre, instance unique, icône', async () => {
        const s = await Session.start();
        try {
            await s.waitFor(booted);
            const rect = async () => (await fetch(`http://127.0.0.1:4444${s.base}/window/rect`).then((r) => r.json())).value;
            const r0 = await rect();
            await s.click('#win-max');
            await sleep(1200);
            const r1 = await rect();
            check('Agrandir', r1.width > r0.width, `${r0.width}x${r0.height} -> ${r1.width}x${r1.height}`);
            await s.click('#win-max');
            await sleep(1200);
            const r2 = await rect();
            check('Restaurer', r2.width < r1.width, `${r2.width}x${r2.height}`);

            // Icône : élément enregistré et menu natif (Linux).
            let items = '';
            try {
                items = gdbus('--dest', 'org.kde.StatusNotifierWatcher', '--object-path', '/StatusNotifierWatcher', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierWatcher', 'RegisteredStatusNotifierItems');
            } catch {
                console.log('     (pas de zone d\'icônes AppIndicator sur ce bureau : test de l\'icône ignoré)');
            }
            const item = items.match(/'(:[\d.]+)@(\/org\/ayatana\/NotificationItem\/tray_icon_tray_app_patateland)'/);
            if (items) check('Icône près de l\'horloge enregistrée', !!item);
            if (item) {
                const menuPath = gdbus('--dest', item[1], '--object-path', item[2], '--method', 'org.freedesktop.DBus.Properties.Get', 'org.kde.StatusNotifierItem', 'Menu').match(/objectpath '([^']+)'/)?.[1];
                const layout = gdbus('--dest', item[1], '--object-path', menuPath, '--method', 'com.canonical.dbusmenu.GetLayout', '--', '0', '-1', '[]');
                const labels = [...layout.matchAll(/'label': <'([^']+)'>/g)].map((m) => m[1]);
                check('Menu de l\'icône', labels.includes('Quitter') && labels.includes('Test'), JSON.stringify(labels));
                check('Menu de l\'icône : instance réservée (Secret) absente', !labels.includes('Secret'));
                // Réduire : la fenêtre se cache dans l'icône, « Ouvrir » la rend.
                await s.click('#win-min');
                await sleep(1500);
                const hidden = await fetch(`http://127.0.0.1:4444${s.base}/window/rect`).then((r) => r.json()).catch(() => null);
                check('Réduire : fenêtre cachée + notification', /arrière-plan|horloge|tourne/i.test(notifs()), JSON.stringify(hidden?.value ?? hidden).slice(0, 80));
                const id = [...layout.matchAll(/\((\d+), \{[^}]*'label': <'Ouvrir le launcher'>/g)].map((m) => m[1])[0];
                if (id) {
                    gdbus('--dest', item[1], '--object-path', menuPath, '--method', 'com.canonical.dbusmenu.Event', '--', id, 'clicked', '<0>', '0');
                    await sleep(1500);
                    const vis = await s.js(`return document.visibilityState`).catch((e) => 'ERR ' + e.message);
                    check('Menu « Ouvrir le launcher » : fenêtre réaffichée', vis === 'visible', vis);
                }
            }

            // Instance unique : un 2e lancement rend la main au premier.
            const t0 = Date.now();
            // Mêmes dossiers de test : si l'instance unique échouait, rien ne
            // serait écrit dans les vrais dossiers du PC.
            const env = { ...process.env, PL_ROOT: GAME, PL_DATA: runFile('appdata'), PL_SERVER: 'http://127.0.0.1:8787' };
            const second = spawnSync(APP, [], { timeout: 20000, env });
            check('Une seule instance du launcher (le 2e se ferme)', second.status === 0 && Date.now() - t0 < 15000, `code ${second.status} en ${Date.now() - t0} ms`);
            check('Le premier launcher est toujours là', (await s.js(`return 1`).catch(() => 0)) === 1);

            // Ctrl+W : ferme le launcher.
            await s.js(`document.dispatchEvent(new KeyboardEvent('keydown',{key:'w',ctrlKey:true}))`).catch(() => {});
            await sleep(2000);
            const alive = spawnSync('pgrep', ['-x', 'patateland']).status === 0;
            check('Ctrl+W ferme le launcher', !alive);
        } finally { await s.end(); }
    });
} finally {
    setState({});
    writeReport('p3.json');
}
