// Faux serveur PatateLand pour les tests de bout en bout (dérivé de
// tools/mock-file-server.mjs) :
//  - HTTP :8787  /config /files /articles /manifest/<i>.json /files/<i>/<chemin>
//  - Minecraft (Server List Ping) :25599, joueurs = state.players
// Fichiers : E2E_MOCK (un dossier par instance), E2E_RUN/state.json.
// L'état (maintenance, liste blanche, instances, joueurs) est relu à chaque
// requête dans state.json : les tests le modifient en cours de route.
// Chaque requête est journalisée dans requests.log.
import { createHash } from 'node:crypto';
import { appendFileSync, createReadStream, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import net from 'node:net';
import { join, relative, resolve, sep } from 'node:path';

const RUN = process.env.E2E_RUN;
const root = resolve(process.env.E2E_MOCK);
const port = 8787;
const base = `http://127.0.0.1:${port}`;
const stateFile = join(RUN, 'state.json');
const readState = () => JSON.parse(readFileSync(stateFile, 'utf8'));
const log = (line) => appendFileSync(join(RUN, 'requests.log'), `${new Date().toISOString()} ${line}\n`);

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}
// Recalculé à chaque requête : les tests ajoutent ou modifient des fichiers.
function manifest(name) {
    const dir = join(root, name);
    return walk(dir).map((file) => {
        const path = relative(dir, file).split(sep).join('/');
        return {
            path,
            hash: createHash('sha1').update(readFileSync(file)).digest('hex'),
            size: statSync(file).size,
            url: `${base}/files/${encodeURIComponent(name)}/${path.split('/').map(encodeURIComponent).join('/')}`,
        };
    });
}

function instances(st) {
    const out = {};
    for (const i of st.instances) {
        out[i.name] = {
            name: i.name,
            url: `${base}/manifest/${encodeURIComponent(i.dir ?? i.name)}.json`,
            loader: i.loader ?? { minecraft_version: '1.20.1', loader_type: 'forge', loader_version: '47.4.16' },
            verify: i.verify ?? true,
            ignored: i.ignored ?? ['options.txt', 'saves', 'logs', 'screenshots', 'crash-reports', 'servers.dat', 'resourcepacks', 'shaderpacks'],
            whitelistActive: !!i.whitelist,
            whitelist: i.whitelist ?? [],
            status: { nameServer: `PatateLand ${i.name}`, ip: '127.0.0.1', port: 25599 },
            jvm_args: [],
            game_args: [],
            description: i.description,
        };
    }
    return out;
}

const json = (res, body) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
};

createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    log(`${req.method} ${url}`);
    const st = readState();
    if (st.down) {
        res.writeHead(503);
        return res.end('down');
    }
    if (url === '/config') return json(res, st.config);
    if (url === '/files') return json(res, instances(st));
    if (url === '/articles') return json(res, st.articles);
    const m = url.match(/^\/manifest\/(.+)\.json$/);
    if (m) return json(res, manifest(m[1]));
    if (url.startsWith('/files/')) {
        const file = resolve(root, '.' + url.slice('/files'.length));
        if (file.startsWith(root + sep)) {
            try {
                const size = statSync(file).size;
                res.writeHead(200, { 'Content-Length': size, 'Content-Type': 'application/octet-stream' });
                return createReadStream(file).pipe(res);
            } catch {}
        }
    }
    res.writeHead(404);
    res.end();
}).listen(port, '127.0.0.1', () => console.log(`HTTP prêt sur ${base}`));

// --- Faux serveur Minecraft : réponse de statut et pong ---
function varint(n) {
    const out = [];
    do {
        let b = n & 0x7f;
        n >>>= 7;
        if (n) b |= 0x80;
        out.push(b);
    } while (n);
    return Buffer.from(out);
}
const packet = (id, payload) => {
    const body = Buffer.concat([varint(id), payload]);
    return Buffer.concat([varint(body.length), body]);
};
net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let answered = false;
    sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        // Après la poignée de main et la demande de statut : la réponse.
        if (!answered && buf.length >= 3) {
            answered = true;
            const st = readState();
            if (st.mcDown) return sock.destroy();
            const status = JSON.stringify({
                version: { name: '1.20.1', protocol: 763 },
                players: { online: st.players ?? 0, max: 100 },
                description: { text: 'Faux serveur PatateLand' },
            });
            const text = Buffer.from(status);
            sock.write(packet(0x00, Buffer.concat([varint(text.length), text])));
            log('MC status');
        }
    });
    sock.on('error', () => {});
}).listen(25599, '127.0.0.1', () => console.log('Minecraft prêt sur 127.0.0.1:25599'));
