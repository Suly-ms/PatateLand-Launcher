// Mini client WebDriver (W3C) pour tauri-driver, et outils de test.
import fs from 'node:fs';
import path from 'node:path';

const HERE = new URL('.', import.meta.url).pathname;
// Dossier de travail (état du faux serveur, journaux, captures) : voir run.sh.
export const RUN = process.env.E2E_RUN ?? path.resolve(HERE, '../../run/e2e');
export const GAME = process.env.E2E_GAME ?? path.join(RUN, 'game');
export const MOCK = process.env.E2E_MOCK ?? path.join(RUN, 'mock');
export const runFile = (name) => path.join(RUN, name);
export const readRun = (name) => { try { return fs.readFileSync(runFile(name), 'utf8'); } catch { return ''; } };
const WD = 'http://127.0.0.1:4444';
export const APP = process.env.E2E_APP ?? path.resolve(HERE, '../../target-msvc/release/patateland');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(method, url, body) {
    const res = await fetch(WD + url, { method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url}: ${JSON.stringify(data.value ?? data).slice(0, 400)}`);
    return data.value;
}

export class Session {
    static async start() {
        const v = await req('POST', '/session', { capabilities: { alwaysMatch: { 'tauri:options': { application: APP } } } });
        const s = new Session(v.sessionId);
        return s;
    }
    constructor(id) { this.id = id; this.base = `/session/${id}`; }
    async end() { await req('DELETE', this.base).catch(() => {}); }
    /** Exécute du JS dans la page (corps de fonction, `return` possible). */
    async js(body, ...args) { return req('POST', `${this.base}/execute/sync`, { script: body, args }); }
    async jsAsync(body, ...args) { return req('POST', `${this.base}/execute/async`, { script: body, args }); }
    async find(css) {
        const v = await req('POST', `${this.base}/element`, { using: 'css selector', value: css });
        return Object.values(v)[0];
    }
    async click(css) {
        const e = await this.find(css);
        try { await req('POST', `${this.base}/element/${e}/click`, {}); }
        catch (err) {
            if (!/intercepted|not interactable/.test(err.message)) throw err;
            this.intercepted = (this.intercepted ?? 0) + 1;
            await this.js(`document.querySelector(arguments[0]).click()`, css);
        }
    }
    async type(css, text) {
        const e = await this.find(css);
        await this.js(`document.querySelector(arguments[0]).value=''`, css);
        try { await req('POST', `${this.base}/element/${e}/value`, { text }); }
        catch (err) {
            if (!/not interactable|not focusable/i.test(err.message)) throw err;
            await this.js(`const i=document.querySelector(arguments[0]); i.value=arguments[1]; i.dispatchEvent(new Event('input',{bubbles:true}));`, css, text);
        }
    }
    async text(css) { return this.js(`const e=document.querySelector(arguments[0]); return e ? e.textContent.trim() : null;`, css); }
    async visible(css) {
        return this.js(`const e=document.querySelector(arguments[0]); if(!e) return false;
            const r=e.getBoundingClientRect(); const s=getComputedStyle(e);
            return !e.closest('.hidden') && s.display!=='none' && s.visibility!=='hidden' && r.width>0 && r.height>0;`, css);
    }
    async waitFor(fnBody, { timeout = 15000, every = 250, label = '' } = {}) {
        const t0 = Date.now();
        let last;
        while (Date.now() - t0 < timeout) {
            last = await this.js(fnBody).catch((e) => `ERR ${e.message}`);
            if (last && !String(last).startsWith('ERR')) return last;
            await sleep(every);
        }
        throw new Error(`délai dépassé (${label || fnBody.slice(0, 80)}) dernier=${JSON.stringify(last)}`);
    }
    async shot(name) {
        const b64 = await req('GET', `${this.base}/screenshot`);
        fs.writeFileSync(path.join(RUN, 'shots', `${name}.png`), Buffer.from(b64, 'base64'));
    }
    /** Appelle une commande Rust directement (comme l'interface). */
    async invoke(cmd, args = {}) {
        return this.jsAsync(`const done = arguments[arguments.length-1];
            window.__TAURI__.core.invoke(arguments[0], arguments[1]).then(v=>done({ok:v}), e=>done({err:String(e)}));`, cmd, args);
    }
}

// --- Rapport ---
export const results = [];
export function check(name, ok, detail = '') {
    results.push({ name, ok: !!ok, detail: String(detail ?? '') });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
export async function step(name, fn) {
    try { await fn(); } catch (e) { check(name, false, e.message); }
}
export function setState(patch) {
    const base = JSON.parse(fs.readFileSync(path.join(HERE, 'state.base.json'), 'utf8'));
    const deep = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] ? deep(a[k], v) : v; return a; };
    fs.writeFileSync(path.join(RUN, 'state.json'), JSON.stringify(deep(base, patch ?? {}), null, 2));
}
export function writeReport(file) {
    fs.writeFileSync(path.join(RUN, file), JSON.stringify(results, null, 2));
    const fails = results.filter((r) => !r.ok);
    console.log(`\n${results.length - fails.length}/${results.length} OK`);
    for (const f of fails) console.log(`  FAIL ${f.name} — ${f.detail}`);
    process.exitCode = fails.length ? 1 : 0;
}
