// Faux serveur de fichiers PatateLand, pour tester le moteur sans le vrai
// serveur. Mêmes routes et mêmes formats que le vrai (web/) :
//   GET /config                     configuration du launcher
//   GET /files                      liste des instances
//   GET /articles                   actualités
//   GET /manifest/<instance>.json   fichiers d'une instance (path, hash, size, url)
//   GET /files/<instance>/<chemin>  contenu des fichiers
//
// Usage : node tools/mock-file-server.mjs [dossier] [port]
//   dossier : contient un sous-dossier par instance (défaut run/mock-server/files)

import { createHash } from "node:crypto";
import { createReadStream, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { join, relative, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "run/mock-server/files");
const port = Number(process.argv[3] ?? 8787);
const base = `http://127.0.0.1:${port}`;

function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
}

const manifests = {};
for (const instance of readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const dir = join(root, instance.name);
    manifests[instance.name] = walk(dir).map((file) => {
        const path = relative(dir, file).split(sep).join("/");
        return {
            path,
            hash: createHash("sha1").update(readFileSync(file)).digest("hex"),
            size: statSync(file).size,
            url: `${base}/files/${encodeURIComponent(instance.name)}/${path.split("/").map(encodeURIComponent).join("/")}`,
        };
    });
    console.log(`${instance.name} : ${manifests[instance.name].length} fichiers`);
}

const config = {
    maintenance: false,
    maintenance_message: "",
    online: false,
    client_id: "",
    dataDirectory: "patateland",
    rss: "",
};

// Même forme que /files du vrai serveur (objet nom -> instance).
const instances = Object.fromEntries(
    Object.keys(manifests).map((name) => [
        name,
        {
            name,
            url: `${base}/manifest/${encodeURIComponent(name)}.json`,
            loader: { minecraft_version: "1.20.1", loader_type: "forge", loader_version: "47.4.16" },
            verify: true,
            ignored: ["options.txt", "optionsof.txt", "saves", "logs", "screenshots", "crash-reports", "journeymap", "local", "servers.dat"],
            whitelistActive: false,
            whitelist: [],
            status: { nameServer: "PatateLand (test local)", ip: "play.patateland.fr", port: 25565 },
            jvm_args: [],
            game_args: [],
        },
    ]),
);

// Actualités de test (format /articles de l'ancien launcher). La deuxième
// contient volontairement du HTML piégé : il doit être neutralisé.
const articles = [
    {
        title: "Bienvenue sur le nouveau launcher (test local)",
        content: "Ceci est une actualité de test servie par le faux serveur local.\nLe vrai serveur PatateLand est actuellement indisponible.\n\nBon jeu à tous !",
        author: "Équipe PatateLand",
        publish_date: "2026-11-20T18:00:00Z",
    },
    {
        title: "Test de sécurité des actualités",
        content: '<p>Ce texte est en <b>gras</b> et ce <a href="https://patateland.fr">lien</a> est autorisé.</p><script>document.body.remove()</script><img src="x" onerror="document.body.remove()"><p><a href="javascript:alert(1)">Lien piégé neutralisé</a></p>',
        author: "Test",
        publish_date: "2026-11-19T12:00:00Z",
    },
];

const json = (res, body) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
};

createServer((req, res) => {
    const url = decodeURIComponent(req.url.split("?")[0]);
    if (url === "/config") return json(res, config);
    if (url === "/files") return json(res, instances);
    if (url === "/articles") return json(res, articles);
    const manifest = url.match(/^\/manifest\/(.+)\.json$/);
    if (manifest && manifests[manifest[1]]) return json(res, manifests[manifest[1]]);
    if (url.startsWith("/files/")) {
        const file = resolve(root, "." + url.slice("/files".length));
        // Jamais de fichier hors du dossier servi.
        if (file.startsWith(root + sep)) {
            try {
                const size = statSync(file).size;
                res.writeHead(200, { "Content-Length": size, "Content-Type": "application/octet-stream" });
                return createReadStream(file).pipe(res);
            } catch {}
        }
    }
    res.writeHead(404);
    res.end();
}).listen(port, "127.0.0.1", () => console.log(`Faux serveur prêt sur ${base}`));
