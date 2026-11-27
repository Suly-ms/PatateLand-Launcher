// Serveur local en lecture seule pour comparer l'ancien et le nouveau launcher.
// /old/* -> ancien launcher (src), /new/* -> nouveau (ui), /h/* -> pages de test.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOTS = {
    // Ancien launcher : lu seulement (jamais modifié). Dossier voisin par défaut.
    old: path.resolve(process.env.PL_OLD_LAUNCHER ?? path.join(HERE, '../../../legacy/electron/src')),
    new: path.resolve(HERE, '../../crates/pl-app/ui'),
    setup: path.resolve(HERE, '../../crates/pl-setup/ui'),
    h: HERE,
};
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.json': 'application/json' };

http.createServer((req, res) => {
    if (req.method !== 'GET') return res.writeHead(405).end();
    const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const [, root, ...rest] = url.split('/');
    let base = ROOTS[root];
    let file = base && path.resolve(base, ...rest);
    // Page de test de l'ancien launcher, servie « dans » son dossier pour ses chemins relatifs.
    if (/^\/old\/h-[a-z-]+\.html$/.test(url) || url === '/old/harness.html') [base, file] = [HERE, path.join(HERE, url === '/old/harness.html' ? 'old-harness.html' : url.slice(5))];
    if (!file || !file.startsWith(base) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end();
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
}).listen(8799, '127.0.0.1', () => console.log('ok'));
