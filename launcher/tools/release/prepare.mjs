// Prépare les fichiers d'une release à partir des installateurs compilés.
//
//   node tools/release/prepare.mjs <dossier>
//
// Le dossier contient les installateurs (noms fixés par la compilation) :
//   PatateLand-win-x64-setup.exe, PatateLand-win-arm64-setup.exe,
//   PatateLand-mac-universal.dmg, PatateLand-linux-x64.AppImage
//
// Écrit dans ce dossier :
// - patateland-update.json (+ .sig) : pour le NOUVEAU launcher, signé avec la
//   clé privée lue dans la variable PL_UPDATE_SIGNING_KEY (secret GitHub) ;
// - latest.yml : pour l'ANCIEN launcher Windows (electron-updater), qui
//   télécharge alors PatateLand-win-x64-setup.exe et le lance avec --updated.
//
// L'ancien launcher Mac/Linux, lui, cherche directement un fichier contenant
// « mac » et finissant par .dmg, ou « linux » et .appimage : les noms
// ci-dessus le respectent.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launcherVersion } from './version.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dir = path.resolve(process.argv[2] ?? 'dist');
const version = launcherVersion();
// Notes de version : fichier NOUVEAUTES.txt à la racine (une ligne par
// nouveauté), affiché aux joueurs dans la fenêtre de mise à jour.
const notesFile = path.join(ROOT, 'NOUVEAUTES.txt');
const notes = (process.env.RELEASE_NOTES ?? (fs.existsSync(notesFile) ? fs.readFileSync(notesFile, 'utf8') : '')).trim();

const PLATFORMS = {
    'windows-x86_64': 'PatateLand-win-x64-setup.exe',
    'windows-aarch64': 'PatateLand-win-arm64-setup.exe',
    macos: 'PatateLand-mac-universal.dmg',
    'linux-x86_64': 'PatateLand-linux-x64.AppImage',
};

const fail = (message) => {
    console.error(`Erreur : ${message}`);
    process.exit(1);
};

// 1. Manifeste : version + empreinte de chaque installateur présent.
const files = {};
for (const [platform, name] of Object.entries(PLATFORMS)) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) fail(`${name} manquant : la release doit contenir les 4 installateurs`);
    const bytes = fs.readFileSync(file);
    files[platform] = { name, sha256: crypto.createHash('sha256').update(bytes).digest('hex'), size: bytes.length };
}
const manifest = Buffer.from(JSON.stringify({ version, notes, files }, null, 2));
fs.writeFileSync(path.join(dir, 'patateland-update.json'), manifest);

// 2. Signature ed25519, avec contrôle : la clé doit être celle intégrée au launcher.
const secret = (process.env.PL_UPDATE_SIGNING_KEY ?? '').trim();
if (!secret) fail('PL_UPDATE_SIGNING_KEY absent (secret GitHub UPDATE_SIGNING_KEY)');
const seed = Buffer.from(secret, 'base64');
if (seed.length !== 32) fail('PL_UPDATE_SIGNING_KEY invalide (32 octets en base64 attendus)');
const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicRaw = crypto.createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const expected = fs.readFileSync(path.join(ROOT, 'crates/pl-engine/update-key.pub'), 'utf8').trim();
if (publicRaw.toString('base64') !== expected) fail('cette clé privée ne correspond pas à la clé publique du launcher');
const signature = crypto.sign(null, manifest, privateKey);
if (!crypto.verify(null, manifest, crypto.createPublicKey(privateKey), signature)) fail('signature invalide');
fs.writeFileSync(path.join(dir, 'patateland-update.json.sig'), signature.toString('base64'));

// 3. latest.yml pour l'ancien launcher Windows (format electron-updater).
const winName = PLATFORMS['windows-x86_64'];
const win = fs.readFileSync(path.join(dir, winName));
const sha512 = crypto.createHash('sha512').update(win).digest('base64');
fs.writeFileSync(
    path.join(dir, 'latest.yml'),
    [
        `version: ${version}`,
        'files:',
        `  - url: ${winName}`,
        `    sha512: ${sha512}`,
        `    size: ${win.length}`,
        `path: ${winName}`,
        `sha512: ${sha512}`,
        `releaseDate: '${new Date().toISOString()}'`,
        '',
    ].join('\n'),
);

console.log(`Release ${version} prête dans ${dir} :`);
for (const f of Object.values(PLATFORMS)) console.log(`  ${f}`);
console.log('  patateland-update.json (+ .sig), latest.yml');
