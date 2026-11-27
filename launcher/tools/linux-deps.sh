#!/usr/bin/env bash
# Dépendances de compilation Linux (Debian/Ubuntu) du launcher.
#
# Avec sudo, le plus simple reste :
#   sudo apt-get install libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev \
#        libssl-dev libdbus-1-dev libxdo-dev build-essential pkg-config
#
# Sans sudo (agent, machine partagée) : ce script télécharge les paquets -dev
# manquants avec `apt-get download` et les extrait dans .toolchain/sysroot,
# sans rien installer sur le système. Les bibliothèques d'exécution
# (libwebkit2gtk-4.1-0, libgtk-3-0…) doivent déjà être installées, ce qui est
# le cas sur un bureau GNOME/KDE.
#
# Usage (depuis launcher/) :
#   bash tools/linux-deps.sh           # dépendances de compilation
#   bash tools/linux-deps.sh --e2e     # + WebKitWebDriver et tauri-driver (tools/e2e)
#   source env.sh && source .toolchain/sysroot-env.sh
set -euo pipefail
cd "$(dirname "$0")/.."
TC="$PWD/.toolchain"
SR="$TC/sysroot"
L="$SR/usr/lib/x86_64-linux-gnu"
mkdir -p "$TC/debs" "$L/pkgconfig"

cat > "$TC/sysroot-env.sh" <<EOF
# Généré par tools/linux-deps.sh : en-têtes et .pc extraits dans le sysroot local.
export PKG_CONFIG_PATH="$L/pkgconfig:$SR/usr/share/pkgconfig\${PKG_CONFIG_PATH:+:\$PKG_CONFIG_PATH}"
export C_INCLUDE_PATH="$SR/usr/include/x86_64-linux-gnu:$SR/usr/include"
export LIBRARY_PATH="$L"
export PATH="$SR/usr/bin:\$PATH"
EOF

installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }
fetch() {
    for p in "$@"; do
        installed "$p" && continue
        ls "$TC/debs/${p}_"*.deb >/dev/null 2>&1 && continue
        (cd "$TC/debs" && apt-get download "$p" >/dev/null) && echo "  téléchargé : $p" || echo "  échec : $p"
    done
}
# Extrait les paquets, puis fait pointer les .pc et les liens .so du sysroot
# vers les bons dossiers (sysroot pour les en-têtes, système pour les .so).
unpack() {
    for f in "$TC"/debs/*.deb; do dpkg-deb -x "$f" "$SR"; done
    find "$SR" -name '*.pc' -type f -exec sed -i -E "s#^(prefix|exec_prefix|libdir|includedir)=/usr#\1=$SR/usr#" {} +
    find "$L" -maxdepth 2 -xtype l -name '*.so*' | while read -r l; do
        ln -sf "/usr/lib/x86_64-linux-gnu/$(basename "$(readlink "$l")")" "$l"
    done
    # Tauri charge libappindicator3 par son nom historique.
    [ -e /usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1 ] &&
        ln -sf /usr/lib/x86_64-linux-gnu/libayatana-appindicator3.so.1 "$L/libappindicator3.so"
    return 0
}

echo "Paquets de développement manquants :"
fetch libssl-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev libsoup-3.0-dev \
    libayatana-appindicator3-dev libayatana-indicator3-dev libayatana-ido3-dev \
    libdbusmenu-glib-dev libdbusmenu-gtk3-dev librsvg2-dev libxdo-dev libxdo3 \
    libgtk-3-dev libglib2.0-dev libcairo2-dev libpango1.0-dev libgdk-pixbuf-2.0-dev libdbus-1-dev

# Dépendances déclarées dans les .pc (Requires.private) : résolues par tours.
declare -A PC=([sqlite3]=libsqlite3-dev [libpsl]=libpsl-dev [krb5-gssapi]="libkrb5-dev krb5-multidev"
    [mit-krb5-gssapi]=krb5-multidev [mit-krb5]=krb5-multidev [krb5]="libkrb5-dev krb5-multidev" [libnghttp2]=libnghttp2-dev
    [dav1d]=libdav1d-dev [libxml-2.0]=libxml2-dev [icu-uc]=libicu-dev [icu-i18n]=libicu-dev
    [libidn2]=libidn2-dev [libbrotlidec]=libbrotli-dev [libbrotlicommon]=libbrotli-dev)
# shellcheck disable=SC1091
source "$TC/sysroot-env.sh"
for round in 1 2 3 4 5 6; do
    unpack
    missing=$(pkg-config --cflags --libs openssl webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 \
        ayatana-appindicator3-0.1 librsvg-2.0 2>&1 | grep -oP "Package '\K[^']+" | sort -u || true)
    [ -z "$missing" ] && break
    echo "Tour $round, .pc manquants : $(echo $missing)"
    for m in $missing; do
        [ -n "${PC[$m]:-}" ] && fetch ${PC[$m]} || echo "  pas de paquet connu pour $m.pc (à ajouter dans ce script)"
    done
done
pkg-config --exists openssl webkit2gtk-4.1 javascriptcoregtk-4.1 libsoup-3.0 ayatana-appindicator3-0.1 librsvg-2.0 \
    && echo "Dépendances de compilation prêtes." \
    || { echo "pkg-config ne résout pas encore tout : voir les messages ci-dessus." >&2; exit 1; }

if [ "${1:-}" = "--e2e" ]; then
    fetch webkitgtk-webdriver
    unpack
    [ -x "$TC/cargo/bin/tauri-driver" ] || (source ./env.sh && cargo install tauri-driver --locked)
    echo "WebKitWebDriver : $SR/usr/bin/WebKitWebDriver"
fi
echo "À faire dans chaque terminal : source env.sh && source .toolchain/sysroot-env.sh"
