<#
.SYNOPSIS
Crée l'utilisateur Windows local "PatateBench" pour les mesures comparatives.

.DESCRIPTION
À lancer UNE FOIS, dans un PowerShell ouvert "en tant qu'administrateur".
- Crée un utilisateur local standard (non administrateur), sans compte Microsoft.
- Crée C:\PatateBench, dossier partagé entre ta session et PatateBench, pour
  y déposer les outils et récupérer les résultats.
Ta session, tes comptes et les données de ton launcher ne sont pas touchés :
PatateBench a son propre %APPDATA%.

Pour tout retirer ensuite : .\remove-patatebench.ps1 (en administrateur).
#>
#Requires -RunAsAdministrator
param(
    [string] $UserName = "PatateBench",
    [string] $Shared = "C:\PatateBench"
)
$ErrorActionPreference = "Stop"

if (Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue) {
    Write-Host "L'utilisateur $UserName existe déjà, rien à créer."
} else {
    # Mot de passe aléatoire, affiché une seule fois.
    $chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    $password = -join (1..16 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] })
    New-LocalUser -Name $UserName `
        -Password (ConvertTo-SecureString $password -AsPlainText -Force) `
        -FullName "PatateLand Bench" `
        -Description "Mesures launcher PatateLand" `
        -PasswordNeverExpires | Out-Null
    Write-Host ""
    Write-Host "Utilisateur $UserName créé."
    Write-Host "Mot de passe : $password"
    Write-Host "(note-le maintenant, il ne sera plus affiché)"
    Write-Host ""
}
# Groupe "Utilisateurs" par son SID (nom traduit selon la langue de Windows).
# Windows l'y ajoute parfois tout seul : on ne l'ajoute que s'il n'y est pas.
$sid = (Get-LocalUser -Name $UserName).SID.Value
if (-not (Get-LocalGroupMember -SID "S-1-5-32-545" | Where-Object { $_.SID.Value -eq $sid })) {
    Add-LocalGroupMember -SID "S-1-5-32-545" -Member $UserName
}

New-Item -ItemType Directory -Force -Path $Shared, "$Shared\results" | Out-Null
icacls $Shared /grant "${UserName}:(OI)(CI)M" /grant "${env:USERNAME}:(OI)(CI)F" | Out-Null

# Outils de mesure et moteur Rust compilé.
$project = Split-Path $PSScriptRoot -Parent
Copy-Item "$PSScriptRoot\*.ps1", "$PSScriptRoot\*.mjs", "$PSScriptRoot\README.md" $Shared -Force
$cli = Join-Path $project "target-msvc\release\pl-cli.exe"
if (Test-Path $cli) { Copy-Item $cli $Shared -Force }

Write-Host ""
Write-Host "Dossier partagé prêt : $Shared"
Write-Host "Étape suivante : changer d'utilisateur (Win+L) et ouvrir la session $UserName,"
Write-Host "puis suivre $Shared\README.md."
