<#
.SYNOPSIS
Lance le nouveau launcher en mode développement, avec rechargement automatique.

.DESCRIPTION
- Modifier un fichier de crates/pl-app/ui (HTML, CSS, JS) : la fenêtre se recharge.
- Modifier du code Rust : le launcher est recompilé puis relancé.
- Données de test du projet (run/game, run/data) : jamais celles de l'ancien launcher.
- Arrêt : Ctrl+C dans le terminal (ou fermer la fenêtre du launcher).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\dev.ps1                    # serveur de démonstration Selvania
powershell -ExecutionPolicy Bypass -File .\dev.ps1 -Server mock       # faux serveur local (Node.js)
powershell -ExecutionPolicy Bypass -File .\dev.ps1 -Server patateland # vrai serveur PatateLand
#>
param(
    [ValidateSet('selvania', 'mock', 'patateland')]
    [string] $Server = 'selvania'
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Outils du projet uniquement (rien n'est installé sur le système).
$env:RUSTUP_HOME = "$root\.toolchain\rustup"
$env:CARGO_HOME = "$root\.toolchain\cargo"
$env:PATH = "$env:CARGO_HOME\bin;$root\.toolchain\binutils;$env:PATH"

# Données de test du projet.
$env:PL_ROOT = "$root\run\game"
$env:PL_DATA = "$root\run\data"
$servers = @{
    selvania   = 'http://luuxcraft.fr/api/user/bb8f5247-1d38-41bb-ab6d-3200471a06b2'
    mock       = 'http://127.0.0.1:8787'
    patateland = 'https://filelauncher.patateland.fr'
}
$env:PL_SERVER = $servers[$Server]

$mock = $null
if ($Server -eq 'mock') {
    $mock = Start-Process node -ArgumentList 'tools/mock-file-server.mjs', 'run/mock-server/files', '8787' `
        -WorkingDirectory $root -NoNewWindow -PassThru
}

Write-Host "Launcher en mode développement - serveur : $Server ($env:PL_SERVER)"
Write-Host "Données de test : $env:PL_DATA"
Write-Host "Arrêt : Ctrl+C"
try {
    Push-Location "$root\crates\pl-app"
    cargo tauri dev
}
finally {
    Pop-Location
    if ($mock -and -not $mock.HasExited) { Stop-Process -Id $mock.Id }
}
