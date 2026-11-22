<#
.SYNOPSIS
Fabrique l'installateur Windows aux couleurs de PatateLand. N'installe rien.

.DESCRIPTION
1. Compile le launcher (Tauri, version finale).
2. Compile le programme d'installation (crates\pl-setup).
3. Ajoute le launcher compressé (et le programme WebView2 de Microsoft) à la
   fin du programme d'installation.

Fonctionne sur ce PC (outils du projet dans .toolchain) et sur les machines
de GitHub (compilation automatique, voir .github/workflows/release.yml).
L'installateur NSIS (build-installer.ps1) reste disponible en secours.

.PARAMETER Arch
x64 (par défaut) ou arm64.

.PARAMETER DownloadWebView2
Télécharge le programme WebView2 de Microsoft s'il n'est pas déjà là
(utilisé par la compilation automatique).

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\build-setup.ps1
# -> dist\PatateLand-win-x64-setup.exe
#>
param(
    [ValidateSet('x64', 'arm64')] [string]$Arch = 'x64',
    [switch]$DownloadWebView2
)
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Outils du projet s'ils existent (ce PC) ; sinon ceux de la machine (GitHub).
if (Test-Path "$root\.toolchain\cargo") {
    $env:RUSTUP_HOME = "$root\.toolchain\rustup"
    $env:CARGO_HOME = "$root\.toolchain\cargo"
    $env:PATH = "$env:CARGO_HOME\bin;$root\.toolchain\binutils;$env:PATH"
}

$target = if ($Arch -eq 'arm64') { 'aarch64-pc-windows-msvc' } else { $null }
$targetArgs = if ($target) { @('--target', $target) } else { @() }
$out = "$root\target-msvc" + $(if ($target) { "\$target" } else { '' })

# CLI Tauri : « cargo tauri » (ce PC) ou « tauri » installé par npm (GitHub).
function Invoke-Tauri([string[]]$arguments) {
    if (Get-Command tauri -ErrorAction SilentlyContinue) { & tauri @arguments } else { & cargo tauri @arguments }
    if ($LASTEXITCODE -ne 0) { throw "tauri $($arguments -join ' ') a échoué" }
}

Push-Location "$root\crates\pl-app"
try { Invoke-Tauri (@('build', '--no-bundle') + $targetArgs) } finally { Pop-Location }

# Profil « setup » (Cargo.toml) : optimisé pour la taille.
Push-Location "$root\crates\pl-setup"
try { Invoke-Tauri (@('build', '--no-bundle') + $targetArgs + @('--', '--profile', 'setup')) } finally { Pop-Location }

# Outil d'assemblage : pour la machine qui compile (jamais pour ARM64).
cargo build --profile setup -p pl-setup --bin pl-pack
if ($LASTEXITCODE -ne 0) { throw "la compilation de pl-pack a échoué" }

$version = (Get-Content "$root\crates\pl-app\tauri.conf.json" -Raw | ConvertFrom-Json).version
New-Item -ItemType Directory -Force "$root\dist" | Out-Null
$installer = "$root\dist\PatateLand-win-$Arch-setup.exe"

$pack = @(
    '--setup', "$out\setup\PatateLand - Installation.exe",
    '--launcher', "$out\release\PatateLand.exe",
    '--version', $version,
    '--out', $installer
)

# Programme officiel de Microsoft, proposé seulement si WebView2 manque sur
# le PC du joueur. Toujours vérifié : signature Microsoft obligatoire.
$webview2 = "$root\target-msvc\.tauri\MicrosoftEdgeWebview2Setup.exe"
if (-not (Test-Path $webview2) -and $DownloadWebView2) {
    New-Item -ItemType Directory -Force (Split-Path $webview2) | Out-Null
    Invoke-WebRequest 'https://go.microsoft.com/fwlink/p/?LinkId=2124703' -OutFile $webview2
}
if (Test-Path $webview2) {
    $signature = Get-AuthenticodeSignature $webview2
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
        throw "MicrosoftEdgeWebview2Setup.exe n'est pas signé par Microsoft : refusé"
    }
    $pack += @('--webview2', $webview2)
}
else {
    Write-Warning "Programme WebView2 absent : l'installateur ne pourra pas l'installer sur un PC qui n'en a pas (relancer avec -DownloadWebView2)."
}

& "$root\target-msvc\setup\pl-pack.exe" @pack
if ($LASTEXITCODE -ne 0) { throw "l'assemblage de l'installateur a échoué" }
