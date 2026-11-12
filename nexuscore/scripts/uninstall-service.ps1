<#
.SYNOPSIS
  Entfernt den NexusCore-Dienst, das Systray-Symbol und alle Firewall-Freigaben, die der Core angelegt hat.
.DESCRIPTION
  Braucht Administratorrechte (hebt sich nicht selbst an). Mit -DryRun werden nur die Schritte angezeigt.
  Die Daten (Server, Benutzer, Backups) bleiben, ausser mit -RemoveData.
  Dieses Skript enthaelt bewusst nur ASCII-Zeichen.
#>
param(
  [string]$ServiceName = 'NexusCore',
  [switch]$RemoveData,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
function Step([string]$Text) { Write-Host "  - $Text" }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
  Write-Host 'Dieses Skript muss als Administrator laufen (PowerShell -> Als Administrator ausfuehren).' -ForegroundColor Red
  exit 1
}

Write-Host "NexusCore-Dienst '$ServiceName' entfernen" -ForegroundColor Cyan
if ($DryRun) { Write-Host '  (Probelauf: es wird nichts veraendert)' -ForegroundColor Yellow }

$svc = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -ne 'Stopped') {
    Step "Dienst anhalten (der Core beendet die Spiele sauber, das kann bis zu zwei Minuten dauern)"
    if (-not $DryRun) {
      Stop-Service -Name $ServiceName -ErrorAction Stop
      $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(150))
    }
  }
  Step "Dienst loeschen: sc.exe delete $ServiceName"
  if (-not $DryRun) { & sc.exe delete $ServiceName | Out-Null }
} else {
  Step 'Dienst ist nicht eingerichtet'
}

Step 'Systray-Autostart entfernen'
if (-not $DryRun) { Remove-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'NexusCoreTray' -ErrorAction SilentlyContinue }
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*nexuscore-tray.ps1*' } | ForEach-Object { Step "Symbol-Prozess $($_.ProcessId) beenden"; if (-not $DryRun) { Stop-Process -Id $_.ProcessId } }

# Nur Regeln mit dem Namen "NexusCore ..." - das sind die, die der Core selbst angelegt hat
$rules = @(Get-NetFirewallRule -DisplayName 'NexusCore *' -ErrorAction SilentlyContinue)
Step "Firewall-Regeln 'NexusCore *': $($rules.Count) gefunden"
if ($rules.Count -gt 0 -and -not $DryRun) { $rules | Remove-NetFirewallRule }

$data = Join-Path $env:ProgramData 'NexusCore'
if (Test-Path -LiteralPath $data) {
  Step 'Zugriffstoken des Symbols loeschen'
  if (-not $DryRun) { Remove-Item -LiteralPath (Join-Path $data 'tray.token') -Force -ErrorAction SilentlyContinue }
  if ($RemoveData) {
    Step "Ordner loeschen: $data"
    if (-not $DryRun) { Remove-Item -LiteralPath $data -Recurse -Force }
  } else {
    Step "Protokolle bleiben in $data (mit -RemoveData loeschen)"
  }
}
Write-Host $(if ($DryRun) { 'Probelauf beendet.' } else { 'Fertig.' }) -ForegroundColor Green
