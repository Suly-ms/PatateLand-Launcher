// Pilote l'ANCIEN launcher (Electron) pour mesurer ses temps, sans clic manuel.
//
// À lancer UNIQUEMENT dans la session Windows PatateBench (voir README.md) :
// il démarre le launcher installé de cette session, avec le port de débogage
// de Chromium pour lire l'état de la page.
//
//   node run-old.mjs                       démarrage → accueil utilisable
//   node run-old.mjs --play --instance Opti   + clic sur JOUER → Java → menu du jeu
//
// Les temps sont écrits dans results\<date>-ancien.json. La RAM et le CPU se
// mesurent en parallèle avec measure.ps1.

import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : fallback;
};

const exe = option("exe", join(process.env.LOCALAPPDATA, "Programs", "PatateLand", "PatateLand.exe"));
const instance = option("instance", "Opti");
const idleSeconds = Number(option("idle", "0"));
const port = 9333;
const gameDir = join(process.env.APPDATA, ".patateland");

if (process.env.USERNAME !== "PatateBench" && !flag("i-know")) {
    console.error("Refusé : ce script ne doit tourner que dans la session PatateBench.");
    process.exit(1);
}
if (!existsSync(exe)) {
    console.error(`Launcher introuvable : ${exe}`);
    process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const elapsed = () => Math.round(performance.now() - t0) / 1000;

async function waitFor(check, timeoutMs, label) {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
        const value = await check().catch(() => null);
        if (value) return value;
        await sleep(100);
    }
    throw new Error(`délai dépassé : ${label}`);
}

async function targets() {
    const res = await fetch(`http://127.0.0.1:${port}/json`);
    return res.json();
}

// Client minimal du protocole Chrome DevTools.
function connect(wsUrl) {
    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        const pending = new Map();
        let nextId = 1;
        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (pending.has(msg.id)) {
                pending.get(msg.id)(msg);
                pending.delete(msg.id);
            }
        };
        ws.onerror = reject;
        ws.onopen = () =>
            resolve({
                async evaluate(expression) {
                    const id = nextId++;
                    const reply = new Promise((r) => pending.set(id, r));
                    ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
                    return (await reply).result?.result?.value;
                },
                close: () => ws.close(),
            });
    });
}

const javaRunning = () => execSync('tasklist /FI "IMAGENAME eq javaw.exe" /NH').toString().includes("javaw.exe");

const results = { launcher: "ancien (Electron)", exe, instance, date: new Date().toISOString() };
const launcher = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: "ignore" });

try {
    await waitFor(async () => (await targets()).find((t) => t.url.includes("index.html")), 60_000, "fenêtre de démarrage");
    results.demarrage_vers_splash_s = elapsed();

    const main = await waitFor(
        async () => (await targets()).find((t) => t.url.includes("launcher.html")),
        300_000,
        "fenêtre principale",
    );
    results.demarrage_vers_fenetre_principale_s = elapsed();

    const page = await connect(main.webSocketDebuggerUrl);
    const panel = await waitFor(
        () => page.evaluate("document.querySelector('.panel.home.active') ? 'home' : document.querySelector('.panel.login.active') ? 'login' : null"),
        300_000,
        "accueil",
    );
    results.demarrage_vers_accueil_s = elapsed();
    results.ecran_atteint = panel;
    console.log(`Accueil (${panel}) atteint en ${results.demarrage_vers_accueil_s} s`);

    if (idleSeconds > 0) {
        console.log(`Repos ${idleSeconds} s (lancer measure.ps1 en parallèle)...`);
        await sleep(idleSeconds * 1000);
    }

    if (flag("play")) {
        if (panel !== "home") throw new Error("pas connecté : connecte le compte de test une première fois");
        if (javaRunning()) throw new Error("un javaw.exe tourne déjà, ferme-le d'abord");
        const selected = await page.evaluate("document.querySelector('.instance-select')?.textContent.trim()");
        if (selected !== instance) throw new Error(`instance sélectionnée : ${selected}, attendue : ${instance}`);
        const click = performance.now();
        await page.evaluate("document.querySelector('.play-btn').click(), true");
        const since = () => Math.round(performance.now() - click) / 1000;

        await waitFor(async () => javaRunning(), 3_600_000, "processus Java");
        results.jouer_vers_processus_java_s = since();
        console.log(`Processus Java lancé ${results.jouer_vers_processus_java_s} s après JOUER`);

        const log = join(gameDir, "instances", instance, "logs", "latest.log");
        const clickedAt = Date.now() - since() * 1000;
        await waitFor(
            async () =>
                existsSync(log) && statSync(log).mtimeMs >= clickedAt && readFileSync(log, "utf8").includes("Sound engine started"),
            1_800_000,
            "menu principal du jeu",
        );
        results.jouer_vers_menu_s = since();
        console.log(`Menu principal ${results.jouer_vers_menu_s} s après JOUER`);
        if (flag("close-game")) execSync("taskkill /IM javaw.exe /F");
    }
    page.close();
} catch (err) {
    results.erreur = String(err?.message ?? err);
    console.error(results.erreur);
} finally {
    if (!flag("keep-open")) execSync(`taskkill /PID ${launcher.pid} /T /F`, { stdio: "ignore" });
}

const outDir = join(import.meta.dirname, "results");
mkdirSync(outDir, { recursive: true });
const file = join(outDir, `${new Date().toISOString().replace(/[:.]/g, "-")}-ancien.json`);
writeFileSync(file, JSON.stringify(results, null, 2));
console.log(`Résultats : ${file}`);
