<#
.SYNOPSIS
Mesure la RAM et le CPU cumulés d'un ensemble de processus.

.DESCRIPTION
Additionne tous les processus portant l'un des noms donnés (un launcher
Electron en lance plusieurs : principal, GPU, réseau, une fenêtre par page).
Écrit un CSV détaillé et ajoute une ligne de synthèse à results\summary.csv.

.EXAMPLE
.\measure.ps1 -Process PatateLand -Seconds 60 -Label ancien-repos-accueil
.\measure.ps1 -Process pl-cli -Seconds 120 -Label nouveau-installation
#>
param(
    [Parameter(Mandatory = $true)] [string[]] $Process,
    [int] $Seconds = 60,
    [int] $IntervalMs = 500,
    [string] $Label = "mesure",
    [string] $OutDir = (Join-Path $PSScriptRoot "results")
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$cores = [Environment]::ProcessorCount
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$csv = Join-Path $OutDir "$stamp-$Label.csv"
$rows = New-Object System.Collections.Generic.List[object]
$start = Get-Date
$end = $start.AddSeconds($Seconds)
$prevCpu = $null
$prevTime = $null

while ((Get-Date) -lt $end) {
    $procs = @(Get-Process -Name $Process -ErrorAction SilentlyContinue)
    $now = Get-Date
    $cpuMs = 0.0
    $private = 0.0
    $ws = 0.0
    foreach ($p in $procs) {
        try { $cpuMs += $p.TotalProcessorTime.TotalMilliseconds } catch { }
        $private += $p.PrivateMemorySize64
        $ws += $p.WorkingSet64
    }
    $cpuPct = ""
    if ($null -ne $prevTime -and $procs.Count -gt 0) {
        $dt = ($now - $prevTime).TotalMilliseconds
        # Un processus qui se ferme fait baisser le total : on borne à 0.
        $cpuPct = [math]::Round([math]::Max(0, ($cpuMs - $prevCpu) / $dt / $cores * 100), 2)
    }
    $rows.Add([pscustomobject]@{
        t_s        = [math]::Round(($now - $start).TotalSeconds, 2)
        processus  = $procs.Count
        prive_mo   = [math]::Round($private / 1MB, 1)
        ws_mo      = [math]::Round($ws / 1MB, 1)
        cpu_pct    = $cpuPct
    })
    $prevCpu = $cpuMs
    $prevTime = $now
    Start-Sleep -Milliseconds $IntervalMs
}

$rows | Export-Csv -Path $csv -NoTypeInformation -Encoding UTF8

$active = @($rows | Where-Object { $_.processus -gt 0 })
$cpu = @($active | Where-Object { $_.cpu_pct -ne "" } | ForEach-Object { [double]$_.cpu_pct })
function Stat($values, $kind) {
    if ($values.Count -eq 0) { return "" }
    $m = $values | Measure-Object -Average -Maximum
    if ($kind -eq "avg") { return [math]::Round($m.Average, 1) } else { return [math]::Round($m.Maximum, 1) }
}
$summary = [pscustomobject]@{
    date             = $stamp
    label            = $Label
    processus        = ($Process -join "+")
    duree_s          = $Seconds
    echantillons     = $active.Count
    nb_processus_max = (Stat @($active | ForEach-Object { $_.processus }) "max")
    prive_moy_mo     = (Stat @($active | ForEach-Object { $_.prive_mo }) "avg")
    prive_max_mo     = (Stat @($active | ForEach-Object { $_.prive_mo }) "max")
    ws_moy_mo        = (Stat @($active | ForEach-Object { $_.ws_mo }) "avg")
    ws_max_mo        = (Stat @($active | ForEach-Object { $_.ws_mo }) "max")
    cpu_moy_pct      = (Stat $cpu "avg")
    cpu_max_pct      = (Stat $cpu "max")
    machine          = $env:COMPUTERNAME
    utilisateur      = $env:USERNAME
}
$summaryFile = Join-Path $OutDir "summary.csv"
$summary | Export-Csv -Path $summaryFile -NoTypeInformation -Encoding UTF8 -Append
$summary | Format-List
Write-Host "Détail : $csv"
