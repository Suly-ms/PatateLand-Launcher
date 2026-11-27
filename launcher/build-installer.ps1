<#
.SYNOPSIS
Fabrique l'installateur du nouveau launcher (NSIS). N'installe rien.

.EXAMPLE
powershell -ExecutionPolicy Bypass -File .\build-installer.ps1
# -> target-msvc\release\bundle\nsis\PatateLand_<version>_x64-setup.exe
#>
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot

# Outils du projet uniquement (rien n'est installé sur le système).
$env:RUSTUP_HOME = "$root\.toolchain\rustup"
$env:CARGO_HOME = "$root\.toolchain\cargo"
$env:PATH = "$env:CARGO_HOME\bin;$root\.toolchain\binutils;$env:PATH"

try {
    Push-Location "$root\crates\pl-app"
    cargo tauri build
    if ($LASTEXITCODE -ne 0) { throw "la fabrication de l'installateur a échoué" }
}
finally {
    Pop-Location
}

$setup = Get-ChildItem "$root\target-msvc\release\bundle\nsis\*-setup.exe" | Sort-Object LastWriteTime | Select-Object -Last 1
Write-Host ""
Write-Host ("Installateur prêt : {0} ({1:N1} Mo)" -f $setup.FullName, ($setup.Length / 1MB))
