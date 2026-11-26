<#
.SYNOPSIS
Supprime l'utilisateur PatateBench et son profil, une fois les mesures terminées.
Les résultats de C:\PatateBench\results sont conservés (à supprimer à la main).
#>
#Requires -RunAsAdministrator
param([string] $UserName = "PatateBench")
$ErrorActionPreference = "Stop"

$user = Get-LocalUser -Name $UserName -ErrorAction SilentlyContinue
if (-not $user) { Write-Host "Aucun utilisateur $UserName."; return }

$profile = Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $user.SID.Value }
if ($profile -and $profile.Loaded) { throw "La session $UserName est encore ouverte : déconnecte-la d'abord." }
if ($profile) { Remove-CimInstance $profile }
Remove-LocalUser -Name $UserName
Write-Host "Utilisateur $UserName et son profil supprimés."
