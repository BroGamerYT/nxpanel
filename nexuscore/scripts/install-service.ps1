<#
.SYNOPSIS
  Richtet NexusCore als Windows-Dienst ein (Autostart, Neustart nach Absturz, sauberes Beenden) und das Systray-Symbol.
.DESCRIPTION
  Braucht eine Eingabeaufforderung/PowerShell "als Administrator". Das Skript hebt sich NICHT selbst an:
  ohne Administratorrechte bricht es ab und sagt, was zu tun ist.
  Mit -DryRun werden nur die Schritte angezeigt, nichts wird veraendert (geht auch ohne Administratorrechte).

  Der Dienst startet nxsvc.exe. Das startet den Core (node dist\index.js), startet ihn nach einem Absturz neu
  und beendet ihn beim Stoppen sauber (Spiele werden gestoppt, bis zu 100 Sekunden). Standard-Konto ist
  LocalSystem - die Spiele laufen dann ebenfalls so. Mit -ServiceUser/-ServicePassword laeuft alles unter einem
  eigenen, eingeschraenkten Konto (empfohlen; es braucht Schreibrechte im Datenordner).
  Dieses Skript enthaelt bewusst nur ASCII-Zeichen.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -DryRun
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1 -OpenCorePort
#>
param(
  [string]$ServiceName = 'NexusCore',
  [string]$CoreDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Node = '',
  [string]$ServiceHost = '',
  [string]$ServiceUser = '',
  [string]$ServicePassword = '',
  [int]$Port = 8443,
  [switch]$OpenCorePort,
  [switch]$NoTray,
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'

function Step([string]$Text) { Write-Host "  - $Text" }
function Run([string]$Exe, [string[]]$Arguments) {
  Step ("$Exe " + ($Arguments -join ' '))
  if ($DryRun) { return }
  & $Exe @Arguments
  if ($LASTEXITCODE -ne 0) { throw "Befehl fehlgeschlagen ($LASTEXITCODE): $Exe $($Arguments -join ' ')" }
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin -and -not $DryRun) {
  Write-Host 'Dieses Skript muss als Administrator laufen.' -ForegroundColor Red
  Write-Host 'Rechtsklick auf PowerShell -> "Als Administrator ausfuehren", dann das Skript erneut starten.'
  Write-Host 'Zum Ansehen der Schritte ohne Aenderung: -DryRun'
  exit 1
}

# --- Dateien finden --------------------------------------------------------------------------------
$svc = @((Join-Path $CoreDir 'nxsvc.exe'), (Join-Path $CoreDir 'helper\nxsvc\target\release\nxsvc.exe')) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $svc) { throw 'nxsvc.exe fehlt. Bauen mit: npm run build:helper (braucht Rust/cargo).' }
if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
$index = Join-Path $CoreDir 'dist\index.js'
if (-not $Node) { throw 'node.exe wurde nicht gefunden. Mit -Node <Pfad> angeben.' }
if (-not (Test-Path -LiteralPath $index)) { throw "dist\index.js fehlt. Zuerst bauen: npm run build ($CoreDir)" }
if (-not (Test-Path -LiteralPath (Join-Path $CoreDir '.env')) -and -not $env:NEXUSCORE_TOKEN) {
  Write-Host 'Hinweis: es gibt keine .env im Core-Ordner. Der Core braucht NEXUSCORE_TOKEN (siehe README).' -ForegroundColor Yellow
}

$data = Join-Path $env:ProgramData 'NexusCore'
$log = Join-Path $data 'logs\core.log'

Write-Host "NexusCore-Dienst '$ServiceName' einrichten" -ForegroundColor Cyan
Write-Host "  Core:  $CoreDir"
Write-Host "  Node:  $Node"
Write-Host "  Huelle: $svc"
Write-Host "  Log:   $log"
if ($DryRun) { Write-Host '  (Probelauf: es wird nichts veraendert)' -ForegroundColor Yellow }

if (-not $DryRun) {
  if (Get-Service -Name $ServiceName -ErrorAction SilentlyContinue) {
    throw "Der Dienst '$ServiceName' gibt es schon. Erst scripts\uninstall-service.ps1 ausfuehren."
  }
  New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null
}

# --- Dienst ----------------------------------------------------------------------------------------
$binPath = '"{0}" service --name {1} --workdir "{2}" --log "{3}" --grace 100 -- "{4}" "{5}"' -f $svc, $ServiceName, $CoreDir, $log, $Node, $index
Step "Dienst anlegen: New-Service -Name $ServiceName -BinaryPathName <$binPath>"
if (-not $DryRun) {
  $params = @{ Name = $ServiceName; BinaryPathName = $binPath; DisplayName = 'NexusCore Host Daemon'; StartupType = 'Automatic' }
  if ($ServiceUser) {
    if (-not $ServicePassword) { throw '-ServiceUser braucht -ServicePassword.' }
    $params.Credential = New-Object System.Management.Automation.PSCredential($ServiceUser, (ConvertTo-SecureString $ServicePassword -AsPlainText -Force))
  }
  $null = New-Service @params
}
# Verzoegerter Autostart: der Dienst startet, wenn der Rechner hochgefahren ist, nicht mittendrin
Run 'sc.exe' @('config', $ServiceName, 'start=', 'delayed-auto')
Run 'sc.exe' @('description', $ServiceName, 'NexusCore: verwaltet Spielserver auf diesem Rechner (Oberflaeche, Kopplung mit dem Panel).')
# Neustart nach Absturz: nach 5 s, 30 s, danach immer 60 s; der Zaehler faengt nach einem Tag neu an
Run 'sc.exe' @('failure', $ServiceName, 'reset=', '86400', 'actions=', 'restart/5000/restart/30000/restart/60000')
Run 'sc.exe' @('failureflag', $ServiceName, '1')
# Beim Herunterfahren Zeit zum sauberen Beenden (Spiele stoppen): drei Minuten statt der Standard-Wartezeit
Run 'reg.exe' @('add', "HKLM\SYSTEM\CurrentControlSet\Services\$ServiceName", '/v', 'PreshutdownTimeout', '/t', 'REG_DWORD', '/d', '180000', '/f')

# --- Systray ---------------------------------------------------------------------------------------
if (-not $NoTray) {
  $tray = Join-Path $CoreDir 'scripts\nexuscore-tray.ps1'
  if (-not (Test-Path -LiteralPath $tray)) { throw "Das Systray-Skript fehlt: $tray" }
  # Token fuer das Symbol: nur Administratoren und SYSTEM duerfen die Datei lesen
  $envFile = Join-Path $CoreDir '.env'
  $tokenLine = if (Test-Path -LiteralPath $envFile) { Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^\s*NEXUSCORE_TOKEN\s*=' } | Select-Object -First 1 } else { $null }
  $token = if ($tokenLine) { ($tokenLine -split '=', 2)[1].Trim().Trim('"') } else { $env:NEXUSCORE_TOKEN }
  $tokenFile = Join-Path $data 'tray.token'
  if ($token) {
    Step "Token fuer das Symbol nach $tokenFile (nur Administratoren)"
    if (-not $DryRun) {
      Set-Content -LiteralPath $tokenFile -Value $token -NoNewline -Encoding ASCII
      & icacls.exe $tokenFile /inheritance:r /grant:r '*S-1-5-32-544:F' '*S-1-5-18:F' | Out-Null
    }
  } else {
    Write-Host '  Kein NEXUSCORE_TOKEN gefunden: das Symbol zeigt dann nur den Status, nicht die Kopplungs-PIN.' -ForegroundColor Yellow
  }
  $cmd = 'powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -Url "http://127.0.0.1:{1}"' -f $tray, $Port
  Step "Autostart des Symbols (alle Benutzer): HKLM Run NexusCoreTray = $cmd"
  if (-not $DryRun) { Set-ItemProperty -Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Run' -Name 'NexusCoreTray' -Value $cmd }
}

# --- Firewall fuer den Core selbst (optional) -------------------------------------------------------
if ($OpenCorePort) {
  Run 'netsh.exe' @('advfirewall', 'firewall', 'add', 'rule', "name=NexusCore Oberflaeche ($Port)", 'dir=in', 'action=allow', 'protocol=TCP', "localport=$Port", 'enable=yes', 'profile=private')
  Write-Host '  Hinweis: der Core hoert nur auf 127.0.0.1, solange NEXUSCORE_HOST nicht anders gesetzt ist.' -ForegroundColor Yellow
}

if (-not $DryRun) {
  Run 'sc.exe' @('start', $ServiceName)
  Write-Host "Fertig. Status: sc query $ServiceName    Log: $log" -ForegroundColor Green
} else {
  Write-Host 'Probelauf beendet.' -ForegroundColor Yellow
}
