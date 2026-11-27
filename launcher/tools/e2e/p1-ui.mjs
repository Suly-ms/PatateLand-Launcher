// Phase 1 : démarrage, connexion hors-ligne, accueil, paramètres.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GAME, Session, check, readRun, runFile, step, sleep, setState, writeReport } from './wd.mjs';

const opened = () => readRun('opened.log');
const notifs = () => readRun('notify.log');
const settingsFile = () => {
    const dir = runFile('appdata');
    const f = fs.readdirSync(dir).find((n) => /settings/i.test(n) && n.endsWith('.json'));
    return f ? JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) : null;
};
const dialogText = (s) => s.js(`const d=document.getElementById('dialog'); return d.classList.contains('hidden') ? null : d.innerText;`);
const closeDialog = (s, label) => s.js(`[...document.querySelectorAll('#dialog-actions button')].find(b=>!arguments[0]||b.textContent===arguments[0])?.click();`, label ?? null);

setState({});
const s = await Session.start();
try {
    // ---------- Démarrage ----------
    await step('démarrage', async () => {
        await s.waitFor(`return document.getElementById('splash').classList.contains('done')`, { label: 'splash' });
        const quote = await s.text('#splash-quote');
        check('Écran de démarrage avec citation', ['Bienvenue sur PatateLand.', "Rien n'est figé ici.", 'Patate un jour, patate toujours.', 'Observe bien. Tout a un sens.'].includes(quote), quote);
        check('Sans compte : écran de connexion', (await s.js(`return document.querySelector('.panel.active')?.id`)) === 'panel-login');
        check('Serveur en mode hors-ligne : formulaire hors-ligne', await s.visible('#login-offline'));
        check('Pas de croix retour au premier lancement', !(await s.visible('#login-back')));
        const bg = await s.js(`return document.getElementById('background').style.backgroundImage`);
        check('Fond aléatoire du thème', /img\/bg\/(dark|light)\/\d\.jpg|easter/.test(bg), bg);
    });

    // ---------- Connexion hors-ligne ----------
    await step('connexion', async () => {
        await s.type('#offline-name', 'ab');
        await s.click('#offline-submit');
        check('Pseudo trop court refusé', /au moins 3 caractères/.test(await dialogText(s)));
        await closeDialog(s);
        await s.type('#offline-name', 'a b c');
        await s.click('#offline-submit');
        check('Pseudo avec espaces refusé', /espaces/.test(await dialogText(s)));
        await closeDialog(s);
        await s.type('#offline-name', 'PatateTest');
        await s.click('#offline-submit');
        await s.waitFor(`return document.querySelector('.panel.active')?.id==='panel-home'`, { label: 'accueil' });
        check('Compte ajouté, retour à l\'accueil', (await s.text('#player-name')) === 'PatateTest');
        check('Message de confirmation', /PatateTest ajouté/.test(await s.text('#toast')), await s.text('#toast'));
        await sleep(1500);
        await s.shot('01-accueil');
    });

    // ---------- Accueil ----------
    await step('actualités', async () => {
        await s.waitFor(`return document.getElementById('news-headline').textContent==='Article un'`, { label: 'news' });
        check('Actualités chargées (première)', true);
        check('3 points de navigation', (await s.js(`return document.querySelectorAll('#news-dots .news-dot').length`)) === 3);
        check('Auteur affiché', /Équipe PatateLand/.test(await s.text('#news-body')));
        check('Bouton précédent désactivé sur la première', await s.js(`return document.getElementById('news-prev').disabled`));
        await s.click('#news-next');
        check('Flèche suivante', (await s.text('#news-headline')) === 'Article piégé');
        await sleep(500);
        const html = await s.js(`return document.getElementById('news-body').innerHTML`);
        check('HTML piégé neutralisé (script, onerror)', !/<script|onerror/i.test(html) && (await s.js(`return window.__pwned`)) == null, html.slice(0, 200));
        check('Lien javascript: neutralisé', !/javascript:/i.test(html));
        check('Mise en forme autorisée conservée (gras, lien https)', /<b>gras<\/b>/.test(html) && /href="https:\/\/patateland\.fr"/.test(html));
        await s.js(`document.querySelectorAll('#news-dots .news-dot')[2].click()`);
        check('Clic sur un point', (await s.text('#news-headline')) === 'Article trois');
        check('Bouton suivant désactivé sur la dernière', await s.js(`return document.getElementById('news-next').disabled`));
        // Défilement automatique (12 s) : retour à la première.
        await s.waitFor(`return document.getElementById('news-headline').textContent==='Article un'`, { timeout: 16000, label: 'carrousel' });
        check('Carrousel automatique (12 s, boucle)', true);
    });

    await step('statut serveur', async () => {
        await s.waitFor(`return /En ligne - \\d+ ms/.test(document.getElementById('status-text').textContent)`, { label: 'statut' });
        check('Statut du serveur Minecraft : en ligne + latence', true, await s.text('#status-text'));
        check('Nombre de joueurs', (await s.text('#players-count')) === '7', await s.text('#players-count'));
        setState({ players: 12 });
        await s.waitFor(`return document.getElementById('players-count').textContent==='12'`, { timeout: 20000, label: 'rafraîchissement statut' });
        check('Statut rafraîchi automatiquement (15 s)', true);
        setState({ mcDown: true });
        await s.waitFor(`return document.getElementById('status-text').textContent.startsWith('Ferme')`, { timeout: 25000, label: 'serveur fermé' });
        check('Serveur Minecraft arrêté : « Ferme »', true, await s.text('#status-text'));
        setState({});
    });

    await step('instances', async () => {
        check('Instance sélectionnée par défaut (première autorisée)', ['Opti','Test'].includes(await s.text('#instance-btn')), await s.text('#instance-btn'));
        await s.click('#instance-btn');
        const names = await s.js(`return [...document.querySelectorAll('#instance-list .instance-name')].map(e=>e.firstChild.textContent)`);
        check('Liste des instances (liste blanche : Secret masquée)', JSON.stringify([...names].sort()) === '["Opti","Test"]', JSON.stringify(names));
        const tips = await s.js(`return Object.fromEntries([...document.querySelectorAll('#instance-list .instance-elements')].map(e=>[e.querySelector('.instance-name').firstChild.textContent, e.querySelector('.instance-info-tooltip').textContent]))`);
        check('Descriptions (serveur, puis texte par défaut pour Opti)', tips.Test === 'Instance de test (Forge 1.20.1).' && /optimisée/.test(tips.Opti), JSON.stringify(tips));
        await s.shot('02-instances');
        const pick = async (n) => {
            await s.js(`[...document.querySelectorAll('#instance-list .instance-elements')].find(e=>e.querySelector('.instance-name').firstChild.textContent===arguments[0]).click()`, n);
            await s.waitFor(`return document.getElementById('instance-btn').textContent===${JSON.stringify(n)}`, { label: `choix ${n}` });
        };
        await pick('Opti');
        check('Choix de l\'instance', (await s.text('#status-name')) === 'PatateLand · Opti');
        check('Choix enregistré', settingsFile()?.selected_instance === 'Opti', settingsFile()?.selected_instance);
        await s.click('#instance-btn');
        await pick('Test');
        check('Retour à Test', settingsFile()?.selected_instance === 'Test');
    });

    await step('liens', async () => {
        const urls = await s.js(`return [...document.querySelectorAll('[data-url]')].map(b=>b.dataset.url)`);
        await s.js(`document.querySelector('[data-url]').click()`);
        await sleep(1500);
        check('Réseaux sociaux : ouverture dans le navigateur', opened().includes(urls[0]), `${urls.length} liens, ouvert: ${opened().trim().split('\n').pop()}`);
        // Une URL hors liste autorisée ne doit pas être ouverte.
        const r = await s.invoke('open_url', { url: 'https://exemple-malveillant.com/' });
        await sleep(800);
        check('URL non autorisée refusée', !!r.err && !opened().includes('exemple-malveillant'), r.err);
    });

    await step('bandeau avis', async () => {
        check('Bandeau « laisser un avis » affiché', await s.visible('#review'));
        await s.click('#review-close');
        check('Bandeau masqué', !(await s.visible('#review')));
        await sleep(500);
        check('Masquage enregistré pour ce compte', (settingsFile()?.review_dismissed_accounts ?? []).length === 1);
    });

    await step('tête du joueur', async () => {
        await s.click('#player');
        check('Compte hors-ligne : la tête ouvre les paramètres', (await s.js(`return document.querySelector('.panel.active')?.id`)) === 'panel-settings');
    });

    // ---------- Paramètres ----------
    await step('onglets', async () => {
        for (const tab of ['account', 'jeu', 'launcher', 'stockage', 'personnalisation']) {
            await s.js(`document.querySelector('[data-tab="${tab}"]').click()`);
            await sleep(300);
            check(`Onglet ${tab}`, await s.js(`return document.getElementById('${tab}-tab').classList.contains('active-container-settings')`));
            await s.shot(`03-param-${tab}`);
        }
        await s.js(`document.querySelector('[data-tab="account"]').click()`);
    });

    await step('multi-comptes', async () => {
        await s.js(`[...document.querySelectorAll('#accounts-list .account')].pop().click()`);
        check('Ajouter un compte : connexion avec croix retour', await s.visible('#login-back'));
        await s.type('#offline-name', 'Deuxieme');
        await s.click('#offline-submit');
        await s.waitFor(`return document.getElementById('player-name').textContent==='Deuxieme'`, { label: 'second compte' });
        await s.js(`document.getElementById('open-settings').click()`);
        const cards = await s.js(`return [...document.querySelectorAll('#accounts-list .profile-name')].map(e=>e.textContent)`);
        check('Deux comptes listés', cards.length === 2, JSON.stringify(cards));
        check('Bandeau avis réaffiché pour le nouveau compte', await s.js(`return !document.getElementById('review').classList.contains('hidden')`));
        await s.js(`[...document.querySelectorAll('#accounts-list .account')].find(c=>c.textContent.includes('PatateTest')).click()`);
        await s.waitFor(`return document.getElementById('player-name').textContent==='PatateTest'`, { label: 'sélection' });
        check('Sélection d\'un compte', true);
        await s.js(`[...document.querySelectorAll('#accounts-list .account')].find(c=>c.textContent.includes('Deuxieme')).querySelector('.delete-profile').click()`);
        check('Confirmation avant suppression', /Deuxieme sera retiré/.test(await dialogText(s)));
        await closeDialog(s, 'Supprimer');
        await s.waitFor(`return document.querySelectorAll('#accounts-list .profile-name').length===1`, { label: 'suppression' });
        check('Compte supprimé', true);
    });

    await step('notifications sociales', async () => {
        await s.js(`document.getElementById('friend-request-notif-toggle').click()`);
        await sleep(400);
        check('Réglage notification demandes d\'amis', settingsFile()?.notify_friend_requests === false);
        await s.js(`document.getElementById('friend-request-notif-toggle').click()`);
    });

    await step('jeu', async () => {
        await s.js(`document.querySelector('[data-tab="jeu"]').click()`);
        await sleep(400);
        const total = await s.text('#total-ram');
        const memGb = Math.round(os.totalmem() / 1073741824 * 10) / 10;
        check('RAM totale du PC', total.startsWith(String(memGb).split('.')[0]), `${total} (os: ${memGb})`);
        check('RAM recommandée affichée', /Go mini \/ \d+(\.\d)? Go maxi/.test(await s.text('#recommended-ram')), await s.text('#recommended-ram'));
        check('Curseur RAM à deux poignées', (await s.js(`return document.querySelectorAll('#memory-slider .slider-touch-left, #memory-slider .slider-touch-right, #memory-slider [class*=touch]').length`)) >= 2);
        await s.click('#apply-recommended-ram');
        await sleep(400);
        check('Appliquer la RAM recommandée', !!settingsFile()?.memory, JSON.stringify(settingsFile()?.memory));
        // Glisser la poignée droite vers la gauche.
        const before = settingsFile()?.memory?.max_gb;
        await s.js(`const t=document.querySelector('#memory-slider .slider-touch-right'); const r=t.getBoundingClientRect();
            const ev=(type,x)=>new MouseEvent(type,{bubbles:true,clientX:x,clientY:r.top+r.height/2});
            t.dispatchEvent(ev('mousedown', r.left+r.width/2)); document.dispatchEvent(ev('mousemove', r.left-60)); document.dispatchEvent(ev('mouseup', r.left-60));
            t.dispatchEvent(new TouchEvent('touchend',{bubbles:true}));`).catch(() => {});
        await sleep(600);
        const after = settingsFile()?.memory?.max_gb;
        check('Curseur RAM : glisser enregistre la valeur', after !== before, `${before} -> ${after}`);
        await s.js(`document.querySelector('.number-btn.plus[data-target="width"]').click()`);
        await sleep(400);
        check('Largeur +', settingsFile()?.width > 1280, settingsFile()?.width);
        await s.type('#height', '800');
        await s.js(`document.getElementById('height').dispatchEvent(new Event('change'))`);
        await sleep(400);
        check('Hauteur saisie', settingsFile()?.height === 800, settingsFile()?.height);
        await s.type('#height', '720800');
        await s.js(`document.getElementById('height').dispatchEvent(new Event('change'))`);
        await sleep(400);
        check('Hauteur hors limites (720800) refusée', settingsFile()?.height !== 720800, `enregistré: ${settingsFile()?.height}`);
        await closeDialog(s);
        await s.click('#size-reset');
        await sleep(400);
        check('Taille par défaut', settingsFile()?.width === 1280 && settingsFile()?.height === 720);
        await s.js(`document.getElementById('fullscreen-toggle').click()`);
        await sleep(400);
        check('Plein écran', settingsFile()?.fullscreen === true);
        await s.js(`document.getElementById('fullscreen-toggle').click()`);
        await s.click('#java-path-reset');
        await sleep(400);
        check('Java du launcher par défaut', (await s.text('#java-path-txt')) === 'Java fourni par le launcher');
    });

    await step('launcher', async () => {
        await s.js(`document.querySelector('[data-tab="launcher"]').click()`);
        await sleep(300);
        for (const b of ['close-none', 'close-window', 'close-launcher']) {
            await s.js(`document.querySelector('[data-close="${b}"]').click()`);
            await sleep(300);
            check(`Comportement pendant le jeu : ${b}`, await s.js(`return document.querySelector('[data-close="${b}"]').classList.contains('active-close')`), settingsFile()?.close_behavior);
        }
        await s.js(`document.querySelector('[data-theme="light"]').click()`);
        await sleep(500);
        check('Thème clair', await s.js(`return document.body.classList.contains('light') && /bg\\/light\\//.test(document.getElementById('background').style.backgroundImage)`));
        await s.shot('04-theme-clair');
        await s.js(`document.querySelector('[data-theme="dark"]').click()`);
        await sleep(500);
        check('Thème sombre', await s.js(`return document.body.classList.contains('dark')`));
        await s.js(`document.querySelector('[data-display="lite"]').click()`);
        await sleep(500);
        check('Mode d\'affichage léger', settingsFile()?.lite_mode === true && /léger/.test(await s.text('#toast')));
        await s.js(`document.querySelector('[data-display="normal"]').click()`);
        await s.js(`document.getElementById('console-toggle').click()`);
        await sleep(300);
        check('Afficher la console', settingsFile()?.show_console === true);
        await s.js(`document.getElementById('crash-report-toggle').click()`);
        await sleep(300);
        check('Rapports de crash (opt-in)', settingsFile()?.send_crash_reports === true);
        await s.js(`document.querySelector('.number-btn.minus[data-target="max-files"]').click()`);
        await sleep(300);
        check('Téléchargements simultanés −', settingsFile()?.download_concurrency === 4, settingsFile()?.download_concurrency);
        await s.click('#max-files-reset');
        await sleep(300);
        check('Téléchargements simultanés par défaut', settingsFile()?.download_concurrency === 5);

        await s.click('#test-notification');
        await sleep(1500);
        check('Notification de test', /Les notifications fonctionnent/.test(notifs()));

        const autostart = path.join(os.homedir(), '.config/autostart');
        const before = fs.existsSync(autostart) ? fs.readdirSync(autostart) : [];
        await s.js(`document.getElementById('autolaunch-toggle').click()`);
        await s.waitFor(`return !document.getElementById('start-minimized-box').classList.contains('hidden')`, { label: 'démarrer réduit', timeout: 5000 }).catch(() => {});
        const added = (fs.existsSync(autostart) ? fs.readdirSync(autostart) : []).filter((f) => !before.includes(f));
        check('Lancement au démarrage du système : activé', added.length === 1 && (await s.visible('#start-minimized-box')), added.join(','));
        if (added[0]) check('Entrée de démarrage pointe vers le launcher', /patateland/i.test(fs.readFileSync(path.join(autostart, added[0]), 'utf8')));
        await s.js(`document.getElementById('start-minimized-toggle').click()`);
        await sleep(300);
        check('Démarrer réduit', settingsFile()?.start_minimized === true);
        await s.js(`document.getElementById('start-minimized-toggle').click()`);
        await s.js(`document.getElementById('autolaunch-toggle').click()`);
        await sleep(800);
        const left = (fs.existsSync(autostart) ? fs.readdirSync(autostart) : []).filter((f) => !before.includes(f));
        check('Lancement au démarrage : désactivé (entrée retirée)', left.length === 0, left.join(','));
    });

    await step('stockage', async () => {
        fs.mkdirSync(path.join(GAME, 'instances/Test/logs'), { recursive: true });
        fs.writeFileSync(path.join(GAME, 'instances/Test/logs/vieux.log'), 'x'.repeat(5000));
        await s.js(`document.querySelector('[data-tab="stockage"]').click()`);
        await s.waitFor(`return /^Total : \\d/.test(document.getElementById('storage-total').textContent)`, { label: 'stockage', timeout: 30000 });
        check('Espace disque calculé', true, await s.text('#storage-total'));
        check('Répartition (6 catégories)', (await s.js(`return document.querySelectorAll('#storage-legend .storage-legend-item').length`)) === 6);
        check('Quarantaine affichée', /Aucun fichier|Restaurer/.test(await s.text('#quarantine')), await s.text('#quarantine'));
        await s.click('#storage-clear-logs');
        check('Confirmation avant de vider les logs', /Vider les logs/.test(await dialogText(s)));
        await closeDialog(s, 'Vider');
        await sleep(1500);
        check('Logs vidés', !fs.existsSync(path.join(GAME, 'instances/Test/logs/vieux.log')), await s.text('#toast'));
        await s.js(`document.querySelector('[data-open-folder="logs"]').click()`);
        await sleep(1000);
        check('Ouvrir le dossier des logs', /instances\/Test\/logs/.test(opened()), opened().trim().split('\n').pop());
    });

    await step('packs', async () => {
        const rp = path.join(GAME, 'instances/Test/resourcepacks');
        const sp = path.join(GAME, 'instances/Test/shaderpacks');
        fs.mkdirSync(rp, { recursive: true });
        fs.mkdirSync(sp, { recursive: true });
        fs.copyFileSync(runFile('pack.zip'), path.join(rp, 'MonPack.zip'));
        fs.copyFileSync(runFile('pack.zip'), path.join(sp, 'MonShader.zip'));
        await s.js(`document.querySelector('[data-tab="personnalisation"]').click()`);
        await sleep(800);
        check('Resource packs listés', /MonPack/.test(await s.text('#packs-resource')), await s.text('#packs-resource'));
        check('Shaders listés', /MonShader/.test(await s.text('#packs-shader')), await s.text('#packs-shader'));
        await s.js(`document.querySelector('#packs-resource .rp-delete-btn').click()`);
        await closeDialog(s, 'Supprimer');
        await sleep(800);
        check('Resource pack supprimé', !fs.existsSync(path.join(rp, 'MonPack.zip')) && !/MonPack/.test(await s.text('#packs-resource')));
        await s.js(`document.querySelector('#packs-shader .sp-delete-btn').click()`);
        await closeDialog(s, 'Supprimer');
        await sleep(800);
        check('Shader supprimé', !fs.existsSync(path.join(sp, 'MonShader.zip')));
        await s.js(`document.querySelector('[data-open-folder="shaderpacks"]').click()`);
        await sleep(1000);
        check('Ouvrir le dossier des shaders', /instances\/Test\/shaderpacks/.test(opened()));
        const r = await s.invoke('open_instance_folder', { folder: '../../..' });
        check('Dossier hors liste refusé', !!r.err, r.err);
    });

    await step('mise à jour', async () => {
        const r = await s.invoke('check_update');
        check('Vérification des mises à jour (GitHub) sans erreur', !r.err, JSON.stringify(r));
    });

    await s.js(`document.getElementById('save').click()`);
    check('Bouton Enregistrer : retour à l\'accueil', (await s.js(`return document.querySelector('.panel.active')?.id`)) === 'panel-home');
} finally {
    await s.end();
    writeReport('p1.json');
}
