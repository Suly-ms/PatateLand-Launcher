// Phase 2 : JOUER (installation, réparation, lancement, console, servers.dat,
// plusieurs instances, crash). Utilise le compte et les réglages de la phase 1.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GAME, MOCK, RUN, Session, check, readRun, step, sleep, setState, writeReport } from './wd.mjs';

const inst = (name, ...p) => path.join(GAME, 'instances', name, ...p);
const opened = () => readRun('opened.log');
const notifs = () => readRun('notify.log');
const dialogText = (s) => s.js(`const d=document.getElementById('dialog'); return d.classList.contains('hidden') ? null : d.innerText;`);
const clickDialog = (s, label) => s.js(`[...document.querySelectorAll('#dialog-actions button')].find(b=>b.textContent===arguments[0])?.click();`, label);
const javaPid = (name) => {
    const out = execSync(`pgrep -af java || true`).toString();
    const line = out.split('\n').find((l) => l.includes(`instances/${name}`) && !l.includes('pgrep'));
    return line ? Number(line.split(' ')[0]) : null;
};

// servers.dat minimal (NBT non compressé) avec un serveur du joueur.
function nbtServers(list) {
    const str = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeUInt16BE(b.length); return Buffer.concat([h, b]); };
    const parts = [Buffer.from([10]), str(''), Buffer.from([9]), str('servers'), Buffer.from([10])];
    const n = Buffer.alloc(4); n.writeInt32BE(list.length); parts.push(n);
    for (const [name, ip] of list) parts.push(Buffer.from([8]), str('name'), str(name), Buffer.from([8]), str('ip'), str(ip), Buffer.from([0]));
    parts.push(Buffer.from([0]));
    return Buffer.concat(parts);
}

setState({});
// Préparation de l'instance Test : fichier modifié (à réparer), fichier en
// trop (à supprimer, verify: true), fichier du joueur (protégé), servers.dat.
// Aussi au tout premier passage (instance pas encore installée).
for (const dir of ['mods', 'config']) fs.mkdirSync(inst('Test', dir), { recursive: true });
fs.writeFileSync(inst('Test', 'config/patatetest.txt'), 'modifié par le joueur');
fs.writeFileSync(inst('Test', 'mods/intrus.jar'), 'intrus');
fs.writeFileSync(inst('Test', 'options.txt'), 'lang:fr_fr\n');
fs.writeFileSync(inst('Test', 'servers.dat'), nbtServers([['MonServeur', 'mc.exemple.fr']]));
// Nouveau fichier côté serveur : doit être téléchargé.
fs.mkdirSync(path.join(MOCK, 'Test/mods'), { recursive: true });
fs.writeFileSync(path.join(MOCK, 'Test/config/nouveau.txt'), 'nouveau fichier serveur');

const s = await Session.start();
try {
    await s.waitFor(`return document.getElementById('splash').classList.contains('done') && document.getElementById('player-name').textContent==='PatateTest'`, { label: 'démarrage' });
    check('Compte et réglages conservés après redémarrage', true);
    await s.invoke('update_settings', { patch: { close_behavior: 'close-none', show_console: true, memory: { min_gb: 1, max_gb: 3 } } });
    await s.invoke('select_instance', { name: 'Test' });
    await s.js(`location.reload()`);
    await s.waitFor(`return document.getElementById('splash').classList.contains('done') && document.getElementById('instance-btn').textContent==='Test'`, { label: 'rechargement' });
    const handles0 = (await s.js(`return 1`)) && (await fetch(`http://127.0.0.1:4444${s.base}/window/handles`).then((r) => r.json())).value;

    await step('lancement', async () => {
        await s.click('#play');
        check('Carte de lancement affichée', await s.visible('#launch-card'));
        check('Bouton JOUER désactivé pendant le lancement', await s.js(`return document.getElementById('play').disabled`));
        // Suivi des étapes vues.
        await s.js(`window.__steps=new Set(); window.__msgs=new Set(); window.__iv=setInterval(()=>{document.querySelectorAll('#launch-card .launch-step.active').forEach((e,i)=>window.__steps.add(e.querySelector('span').textContent)); window.__msgs.add(document.getElementById('launch-message').textContent)},100)`);
        await s.shot('10-lancement');
        await s.waitFor(`return document.getElementById('launch-message').textContent==='Bon jeu !'`, { timeout: 600000, every: 1000, label: 'menu principal (premier passage : téléchargement de Minecraft)' });
        check('Minecraft atteint le menu principal (« Bon jeu ! »)', true);
        const msgs = await s.js(`clearInterval(window.__iv); return [...window.__msgs]`);
        check('Messages de progression', msgs.some((m) => /Vérification|Fichiers|Préparation/.test(m)) && msgs.some((m) => /Minecraft/.test(m)), JSON.stringify(msgs).slice(0, 300));
        check('Titre « En jeu »', (await s.text('#play-title')) === 'En jeu');
        await sleep(1500);
        check('Notification « Test a démarré ! »', /Test a démarré/.test(notifs()));
        await s.shot('11-en-jeu');
    });

    await step('fichiers de l\'instance', async () => {
        check('Fichier modifié réparé', fs.readFileSync(inst('Test', 'config/patatetest.txt'), 'utf8') === fs.readFileSync(path.join(MOCK, 'Test/config/patatetest.txt'), 'utf8'));
        check('Nouveau fichier du serveur téléchargé', fs.existsSync(inst('Test', 'config/nouveau.txt')));
        check('Fichier en trop supprimé (verify: true)', !fs.existsSync(inst('Test', 'mods/intrus.jar')));
        check('Fichier du joueur protégé (ignored)', fs.existsSync(inst('Test', 'options.txt')));
        const dat = fs.readFileSync(inst('Test', 'servers.dat')).toString('latin1');
        check('servers.dat : serveur PatateLand ajouté', dat.includes('127.0.0.1:25599'));
        check('servers.dat : serveur du joueur conservé', dat.includes('mc.exemple.fr'));
    });

    await step('console', async () => {
        const handles = (await fetch(`http://127.0.0.1:4444${s.base}/window/handles`).then((r) => r.json())).value;
        check('Console de jeu ouverte (fenêtre séparée)', handles.length > handles0.length, `${handles0.length} -> ${handles.length}`);
        const main = (await fetch(`http://127.0.0.1:4444${s.base}/window`).then((r) => r.json())).value;
        const other = handles.find((h) => h !== main);
        if (other) {
            await fetch(`http://127.0.0.1:4444${s.base}/window`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: other }) });
            await sleep(500);
            const txt = await s.js(`return document.body.innerText`);
            check('Console : lignes du jeu', /Sound engine started|Forge|LWJGL/.test(txt), txt.slice(0, 120).replace(/\n/g, ' | '));
            await s.shot('12-console');
            await fetch(`http://127.0.0.1:4444${s.base}/window`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: main }) });
        }
    });

    await step('pendant le jeu', async () => {
        const r = await s.invoke('clear_logs');
        check('Vider les logs refusé pendant une partie', /ferme d'abord le jeu/.test(r.err ?? ''), r.err);
    });

    await step('deuxième instance', async () => {
        const r = await s.invoke('play', { instance: 'Opti' });
        check('Lancer une deuxième instance en même temps', !r.err, r.err);
        const t0 = Date.now();
        let pid = null;
        while (!pid && Date.now() - t0 < 300000) { await sleep(2000); pid = javaPid('Opti'); }
        check('Opti démarrée (installation + Java)', !!pid, `après ${Math.round((Date.now() - t0) / 1000)} s`);
        await s.waitFor(`return null`, { timeout: 1 }).catch(() => {});
        // Laisser Opti atteindre le menu.
        const t1 = Date.now();
        while (Date.now() - t1 < 120000 && !/Opti a démarré/.test(notifs())) await sleep(2000);
        check('Notification « Opti a démarré ! »', /Opti a démarré/.test(notifs()));
        check('Les deux jeux tournent', !!javaPid('Test') && !!javaPid('Opti'));
    });

    await step('crash avec rapport', async () => {
        // Rapport de crash écrit par « Minecraft », puis arrêt brutal.
        fs.mkdirSync(inst('Opti', 'crash-reports'), { recursive: true });
        fs.writeFileSync(inst('Opti', 'crash-reports', 'crash-2026-11-27_10.00.00-client.txt'), '---- Minecraft Crash Report ----\n// Test\nDescription: Test de crash\n');
        process.kill(javaPid('Opti'), 'SIGKILL');
        await s.waitFor(`return /Crash de Minecraft/.test(document.getElementById('dialog-title').textContent) && !document.getElementById('dialog').classList.contains('hidden')`, { timeout: 30000, label: 'dialogue de crash' });
        const t = await dialogText(s);
        check('Crash détecté : dialogue', true, t.replace(/\n/g, ' | '));
        check('Rapport de crash trouvé', /rapport de crash a été enregistré/.test(t));
        check('Rapport préparé pour l\'envoi (opt-in)', /prêt à être transmis/.test(t));
        await s.shot('13-crash');
        await clickDialog(s, 'Ouvrir le rapport');
        await sleep(1000);
        const last = opened().trim().split('\n').pop();
        check('« Ouvrir le rapport » ouvre le rapport de l\'instance qui a planté (Opti)', /instances\/Opti\/crash-reports\/crash-.*\.txt/.test(last), last);
        check('Test tourne encore : l\'écran reste « En jeu »', /^En jeu · Test/.test(await s.text('#play-title')) && (await s.js(`return document.getElementById('play').disabled`)), await s.text('#play-title'));
        const queue = execSync(`find ${RUN}/appdata ${GAME} -path '*crash-queue*' -type f 2>/dev/null || true`).toString().trim();
        check('Rapport mis en file d\'attente', queue.length > 0, queue.split('\n')[0]);
    });

    await step('fin de partie', async () => {
        process.kill(javaPid('Test'), 'SIGKILL');
        await s.waitFor(`return !document.getElementById('play').disabled && !document.getElementById('dialog').classList.contains('hidden')`, { timeout: 30000, label: 'JOUER réactivé' });
        check('JOUER réactivé après la partie', true);
        const t = await dialogText(s);
        check('Crash sans rapport : dialogue sans mention de rapport', /Crash/.test(t ?? '') && !/rapport de crash a été enregistré/.test(t ?? ''), (t ?? '').replace(/\n/g, ' | '));
        await clickDialog(s, 'Fermer');
        check('Titre revenu à « Choisissez votre instance »', (await s.text('#play-title')) === 'Choisissez votre instance');
    });

    await step('relance rapide', async () => {
        const t0 = Date.now();
        await s.click('#play');
        await s.waitFor(`return document.getElementById('launch-message').textContent==='Bon jeu !'`, { timeout: 180000, every: 500, label: 'menu (2e)' });
        check('Deuxième lancement (fichiers déjà là)', true, `${Math.round((Date.now() - t0) / 1000)} s jusqu'au menu`);
        process.kill(javaPid('Test'), 'SIGTERM');
        await s.waitFor(`return !document.getElementById('play').disabled`, { timeout: 30000, label: 'fin' });
        await clickDialog(s, 'Fermer');
    });
} finally {
    await s.end();
    writeReport('p2.json');
}
