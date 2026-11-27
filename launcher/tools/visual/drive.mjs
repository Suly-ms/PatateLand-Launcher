// Pilote Chrome sans fenêtre (headless) par le protocole DevTools.
// node drive.mjs <scenario.json>  ->  captures PNG dans ./shots
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const scenario = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
// Captures et profil Chrome temporaire dans run/ (ignoré par git).
const RUN = path.join(HERE, '../../run/visual');
const shots = path.join(RUN, 'shots');
fs.mkdirSync(shots, { recursive: true });

const chrome = spawn(CHROME, [
    '--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${path.join(RUN, 'profile')}`,
    '--no-first-run', '--no-default-browser-check', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let version;
for (let i = 0; i < 50 && !version; i++) {
    await sleep(200);
    version = await fetch('http://127.0.0.1:9333/json/list').then((r) => r.json()).catch(() => null);
}
const page = version.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    }
});
const send = (method, params = {}) =>
    new Promise((resolve) => {
        const id = ++seq;
        pending.set(id, resolve);
        ws.send(JSON.stringify({ id, method, params }));
    });

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: scenario.width ?? 1280, height: scenario.height ?? 720, deviceScaleFactor: 1, mobile: false });
if (scenario.stub) {
    const stubFile = typeof scenario.stub === 'string' ? scenario.stub : 'stub.js';
    await send('Page.addScriptToEvaluateOnNewDocument', { source: fs.readFileSync(path.join(HERE, stubFile), 'utf8') });
}

const out = {};
for (const step of scenario.steps) {
    if (step.nav) {
        await send('Page.navigate', { url: step.nav });
        await sleep(step.wait ?? 1500);
    } else if (step.eval) {
        const r = await send('Runtime.evaluate', { expression: step.eval, awaitPromise: true, returnByValue: true });
        if (step.save) out[step.save] = r.result?.result?.value ?? r.result?.exceptionDetails?.exception?.description;
        if (step.wait) await sleep(step.wait);
    } else if (step.sleep) {
        await sleep(step.sleep);
    } else if (step.shot) {
        const r = await send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(shots, `${step.shot}.png`), Buffer.from(r.result.data, 'base64'));
    }
}
console.log(JSON.stringify(out, null, 1));
ws.close();
chrome.kill();
