# Toolchain Rust locale au projet (rien n'est installé ailleurs sur le PC).
# Usage : source env.sh
_PL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export RUSTUP_HOME="$_PL_ROOT/.toolchain/rustup"
export CARGO_HOME="$_PL_ROOT/.toolchain/cargo"
# as + dlltool extraits de MinGW-w64 portable (WinLibs), requis par la cible GNU ; le linker reste celui fourni par Rust.
export PATH="$CARGO_HOME/bin:$_PL_ROOT/.toolchain/binutils:$PATH"
