#!/usr/bin/env bash
# Lance le nouveau launcher sur les données de test du projet (jamais celles
# de l'ancien launcher). Faux serveur local : node tools/mock-file-server.mjs
cd "$(dirname "$0")"
export PL_ROOT="$PWD/run/game" PL_DATA="$PWD/run/data" PL_SERVER="${PL_SERVER:-http://127.0.0.1:8787}"
exec ./target-msvc/release/patateland.exe "$@"
