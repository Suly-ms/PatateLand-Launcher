#!/usr/bin/env bash
# Tests de bout en bout du launcher (Linux). Voir README.md.
#   bash tools/e2e/run.sh            # p1 p2 p3 p4
#   bash tools/e2e/run.sh p1 p3      # phases au choix
set -uo pipefail
SRC=$(cd "$(dirname "$0")" && pwd)
L=$(cd "$SRC/../.." && pwd)                       # launcher/
export E2E_RUN=${E2E_RUN:-$L/run/e2e}
export E2E_GAME=$E2E_RUN/game E2E_MOCK=$E2E_RUN/mock
export E2E_APP=${E2E_APP:-$L/target-msvc/release/patateland}
export E2E_CLI=$L/target-msvc/release/pl-cli

die() { echo "Erreur : $*" >&2; exit 2; }
command -v node >/dev/null || die "Node.js introuvable"
[ -x "$E2E_APP" ] && [ -x "$E2E_CLI" ] || die "compiler d'abord : cargo build --release -p pl-app -p pl-cli"
WKD=$(command -v WebKitWebDriver || echo "$L/.toolchain/sysroot/usr/bin/WebKitWebDriver")
TD=$(command -v tauri-driver || echo "$L/.toolchain/cargo/bin/tauri-driver")
[ -x "$WKD" ] && [ -x "$TD" ] || die "WebKitWebDriver ou tauri-driver absent : bash tools/linux-deps.sh --e2e"
for port in 4444 8787 25599; do
    (echo > /dev/tcp/127.0.0.1/$port) 2>/dev/null && die "port $port déjà utilisé (autre test en cours ?)"
done
pgrep -x patateland >/dev/null && die "un launcher PatateLand est déjà ouvert : le fermer (une seule instance possible)"

# Dossier de travail : données du launcher neuves, dossier de jeu conservé
# (évite de retélécharger Minecraft).
rm -rf "$E2E_RUN/appdata" "$E2E_RUN/cli-data" "$E2E_RUN/shots"
mkdir -p "$E2E_RUN/appdata" "$E2E_RUN/shots" "$E2E_RUN/bin" "$E2E_MOCK/Test/config" "$E2E_GAME"
echo "# fichier de test" > "$E2E_MOCK/Test/config/patatetest.txt"
rm -f "$E2E_MOCK/Test/config/nouveau.txt" "$E2E_MOCK/Test/mods/vrai.jar"
cp "$SRC/state.base.json" "$E2E_RUN/state.json"
: > "$E2E_RUN/requests.log"; : > "$E2E_RUN/opened.log"; : > "$E2E_RUN/notify.log"
python3 -c "
import zipfile; z=zipfile.ZipFile('$E2E_RUN/pack.zip','w')
z.writestr('pack.mcmeta','{\"pack\":{\"pack_format\":15,\"description\":\"test\"}}'); z.close()"
# Faux xdg-open : liens et dossiers notés, aucun navigateur ouvert.
printf '#!/bin/sh\necho "$(date +%%T) $*" >> "%s/opened.log"\n' "$E2E_RUN" > "$E2E_RUN/bin/xdg-open"
chmod +x "$E2E_RUN/bin/xdg-open"

PIDS=()
cleanup() {
    for p in "${PIDS[@]}"; do pkill -P "$p" 2>/dev/null; kill "$p" 2>/dev/null; done
    # Jeux lancés par les tests (dossier de jeu de test uniquement).
    for p in $(pgrep -x java); do
        tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q -- "$E2E_GAME" && kill "$p"
    done
}
trap cleanup EXIT INT TERM

node "$SRC/mock.mjs" > "$E2E_RUN/mock.log" 2>&1 & PIDS+=($!)
dbus-monitor --session "interface='org.freedesktop.Notifications',member='Notify'" > "$E2E_RUN/notify.log" 2>&1 & PIDS+=($!)
PATH="$E2E_RUN/bin:$PATH" PL_ROOT="$E2E_GAME" PL_DATA="$E2E_RUN/appdata" PL_SERVER=http://127.0.0.1:8787 \
    "$TD" --native-driver "$WKD" > "$E2E_RUN/driver.log" 2>&1 & PIDS+=($!)
for _ in $(seq 50); do
    curl -s http://127.0.0.1:4444/status | grep -q '"ready":true' && curl -s -o /dev/null http://127.0.0.1:8787/config && break
    sleep 0.2
done

status=0
for phase in "${@:-p1 p2 p3 p4}"; do
    for p in $phase; do
        echo; echo "===== $p ====="
        case $p in
            p1) node "$SRC/p1-ui.mjs" ;;
            p2) node "$SRC/p2-play.mjs" ;;
            p3) node "$SRC/p3-misc.mjs" ;;
            p4) bash "$SRC/p4-engine.sh" ;;
            *) echo "phase inconnue : $p"; false ;;
        esac || status=1
    done
done
echo; echo "Résultats et captures : $E2E_RUN"
exit $status
