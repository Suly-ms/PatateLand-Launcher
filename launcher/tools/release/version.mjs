// Version du launcher : un seul endroit, la ligne `version = "…"` de la
// section [workspace.package] du Cargo.toml à la racine. Tauri la reprend
// automatiquement (aucune version dans les tauri.conf.json).
//
//   node tools/release/version.mjs   ->  2.0.0

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

export function launcherVersion() {
    const cargo = fs.readFileSync(path.join(ROOT, 'Cargo.toml'), 'utf8');
    const section = cargo.split(/^\[/m).find((s) => s.startsWith('workspace.package]'));
    const version = section?.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    if (!version) throw new Error('version introuvable dans [workspace.package] du Cargo.toml');
    return version;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    console.log(launcherVersion());
}
