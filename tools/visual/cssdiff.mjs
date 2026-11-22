// Compare les règles CSS de l'ancien launcher et de la copie du nouveau.
// node cssdiff.mjs <ancien.css> <nouveau.css> <préfixe à retirer, ex. "#panel-settings ">
import fs from 'node:fs';

function parse(file, prefix) {
    const text = fs.readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const rules = new Map();
    // Ignore les blocs @keyframes / @media (comparés à part si besoin).
    const flat = text.replace(/@(keyframes|media)[^{]*\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    for (const m of flat.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = Object.fromEntries(
            m[2].split(';').map((d) => d.trim()).filter(Boolean).map((d) => {
                const i = d.indexOf(':');
                return [d.slice(0, i).trim(), d.slice(i + 1).trim().replace(/\s+/g, ' ')];
            }),
        );
        for (let sel of m[1].split(',')) {
            sel = sel.trim().replace(/\s+/g, ' ');
            if (prefix) sel = sel.split(prefix).join('');
            if (!sel || sel.startsWith('@')) continue;
            rules.set(sel, { ...(rules.get(sel) ?? {}), ...decls });
        }
    }
    return rules;
}

const [oldFile, newFile, prefix = ''] = process.argv.slice(2);
const oldRules = parse(oldFile, '');
const newRules = parse(newFile, prefix);
for (const [sel, decls] of oldRules) {
    const mine = newRules.get(sel);
    if (!mine) {
        console.log(`MANQUANT  ${sel}`);
        continue;
    }
    for (const [k, v] of Object.entries(decls)) {
        if (mine[k] === undefined) console.log(`ABSENT    ${sel} { ${k}: ${v} }`);
        else if (mine[k] !== v) console.log(`DIFFÉRENT ${sel} { ${k}: ${v}  →  ${mine[k]} }`);
    }
    for (const [k, v] of Object.entries(mine)) if (decls[k] === undefined) console.log(`AJOUTÉ    ${sel} { ${k}: ${v} }`);
}
