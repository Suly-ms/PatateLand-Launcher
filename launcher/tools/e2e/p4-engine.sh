#!/usr/bin/env bash
# Phase 4 : moteur via pl-cli (réparation, quarantaine, packs, stockage,
# réglages, comptes). Faux serveur sur :8787 (état de base). Lancé par run.sh.
# Variables fournies par run.sh : E2E_RUN, E2E_GAME, E2E_MOCK, E2E_CLI.
SRC=$(cd "$(dirname "$0")" && pwd); E=$E2E_RUN
G=$E2E_GAME; MOCK=$E2E_MOCK; D=$E/cli-data
B=$E2E_CLI
cli() { "$B" --server http://127.0.0.1:8787 --root "$G" --data "$D" "$@" 2>&1; }
pass=0; fail=0
ok() { if eval "$2"; then echo "OK   $1"; pass=$((pass+1)); else echo "FAIL $1 ${3:-}"; fail=$((fail+1)); fi; }
rm -rf "$D"; mkdir -p "$D"
cp "$SRC/state.base.json" "$E/state.json"

# --- Quarantaine ---
mkdir -p "$MOCK/Test/mods"
python3 -c "
import zipfile; z=zipfile.ZipFile('$MOCK/Test/mods/vrai.jar','w'); z.writestr('META-INF/MANIFEST.MF','Manifest-Version: 1.0\n'); z.close()"
cli install --instance Test > "$E/p4-1.log"
ok "Mod officiel installé" "[ -f $G/instances/Test/mods/vrai.jar ]"
echo "pas une archive" > "$G/instances/Test/mods/vrai.jar"
echo "<!DOCTYPE html><html><body>Erreur 404</body></html>" > "$G/instances/Test/mods/page.jar"
cli install --instance Test > "$E/p4-2.log"
ok "Mod abîmé remplacé par la version du serveur" "cmp -s $G/instances/Test/mods/vrai.jar $MOCK/Test/mods/vrai.jar"
ok "Page web déguisée en .jar retirée du dossier mods" "[ ! -f $G/instances/Test/mods/page.jar ]"
Q=$(cli quarantine)
echo "$Q" | sed 's/^/     /' | head -6
ok "Quarantaine : page web listée avec sa raison" "echo \"\$Q\" | grep page.jar | grep -q 'page web'"
ID=$(echo "$Q" | grep page.jar | grep -oE 'q[0-9]+-[0-9]+' | tail -1)
cli quarantine --restore "$ID" > "$E/p4-3.log"
ok "Restauration depuis la quarantaine" "grep -q 'Erreur 404' $G/instances/Test/mods/page.jar" "id=$ID $(tail -2 $E/p4-3.log)"
rm -f "$G/instances/Test/mods/page.jar" "$MOCK/Test/mods/vrai.jar"
cli install --instance Test > /dev/null   # retire vrai.jar de l'instance

# --- Réparation des fichiers partagés ---
LIB=$(find "$G" -path '*libraries*' -name 'guava-*.jar' | head -1)
cp "$LIB" "$E/lib.bak"
printf 'corrompu' | dd of="$LIB" bs=1 seek=1000 conv=notrunc 2>/dev/null
cli install --instance Test > "$E/p4-4.log"
FAST=$(cmp -s "$LIB" "$E/lib.bak" && echo repare || echo intact)
cli install --instance Test --full-verify > "$E/p4-5.log"
ok "Bibliothèque corrompue (même taille) réparée par « Réparer » (--full-verify)" "cmp -s $LIB $E/lib.bak" "$(grep -E 'vérifiés' $E/p4-5.log | head -2)"
echo "     (vérification rapide seule : $FAST — attendu : intact, l'index rapide ne relit pas le contenu)"
truncate -s 100 "$LIB"
cli install --instance Test > "$E/p4-6.log"
ok "Bibliothèque tronquée réparée par la vérification rapide" "cmp -s $LIB $E/lib.bak"

# --- Packs ---
cli packs --instance Test --kind resource --add "$E/pack.zip" > /dev/null
ok "packs --add" "[ -f $G/instances/Test/resourcepacks/pack.zip ]"
ok "packs (liste)" "cli packs --instance Test --kind resource | grep -q pack.zip"
cli packs --instance Test --kind resource --remove pack.zip > /dev/null
ok "packs --remove" "[ ! -f $G/instances/Test/resourcepacks/pack.zip ]"
R=$(cli packs --instance Test --kind resource --add "$E/state.json")
ok "Fichier autre que .zip refusé" "[ ! -f $G/instances/Test/resourcepacks/state.json ]" "$R"

# --- Réglages ---
cli settings set memory '{"min_gb":2,"max_gb":4}' > /dev/null
ok "settings set memory" "cli settings show | grep -q '4'"
R=$(cli settings set memory '{"min_gb":2,"max_gb":999}')
ok "RAM au-delà de 80 % refusée" "echo \"$R\" | grep -qi 'maximum'" "$R"
R=$(cli settings set download_concurrency 99)
ok "Téléchargements simultanés > 32 refusés" "echo \"$R\" | grep -qi '32'" "$R"
R=$(cli settings set height 720800)
ok "Hauteur 720800 refusée" "echo \"$R\" | grep -qiE 'grande|maximum|résolution'" "$R"
cli settings reset > /dev/null

# --- Comptes ---
cli account add-offline --name CliTest > /dev/null
cli account add-offline --name Autre > /dev/null
ok "Comptes hors-ligne (2)" "[ \$(cli account list | grep -c 'hors-ligne') -eq 2 ]"
R=$(cli account refresh)
ok "Vérification des comptes sans suppression" "[ \$(cli account list | grep -c 'hors-ligne') -eq 2 ]" "$R"
cli account select Autre > /dev/null
ok "Sélection du compte" "cli account list | grep '^\*' | grep -q Autre"
cli account remove Autre > /dev/null
ok "Suppression explicite" "[ \$(cli account list | grep -c 'hors-ligne') -eq 1 ]"
R=$(cli account add-offline --name 'a b')
ok "Pseudo invalide refusé (CLI)" "! cli account list | grep -q 'a b'" "$R"

# --- Stockage ---
mkdir -p "$G/instances/Test/logs" && echo x > "$G/instances/Test/logs/a.log"
cli storage --clear-logs Test > /dev/null
ok "storage --clear-logs" "[ ! -f $G/instances/Test/logs/a.log ]"
S=$(cli storage)
echo "$S" | sed 's/^/     /' | head -8
ok "storage (répartition)" "echo \"$S\" | grep -qiE 'total'"

echo; echo "$pass/$((pass+fail)) OK"
printf '{"pass":%d,"fail":%d}\n' "$pass" "$fail" > "$E/p4.json"
[ "$fail" -eq 0 ]
