# NexusPanel - Installation unter Windows 10/11
# In einer PowerShell als Administrator:
#   Set-ExecutionPolicy -Scope Process Bypass
#   .\install-windows.ps1
#
# Voraussetzung: Docker Desktop mit WSL2-Backend.
# Windows eignet sich zum Entwickeln und Ausprobieren. Fuer den Dauerbetrieb
# mit mehreren Gameservern ist eine Linux-VM die bessere Wahl.

[CmdletBinding()]
param(
    [string]$InstallDir = "C:\GameserverPanel",
    [int]$PanelPort     = 8080,
    [string]$PortRange  = "25500-25600",
    [string]$PanelImage = "ghcr.io/brogameryt/nxpanel:latest"
)

$ErrorActionPreference = "Stop"

function Write-Step { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Warn { param($m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[x] $m" -ForegroundColor Red }

# --- Administrator ----------------------------------------------------------
$identity  = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Err "Bitte eine PowerShell als Administrator oeffnen."
    exit 1
}

# --- Voraussetzungen --------------------------------------------------------
Write-Step "Voraussetzungen pruefen"

$wslOk = $false
try { wsl.exe --status *> $null; $wslOk = ($LASTEXITCODE -eq 0) } catch { $wslOk = $false }
if (-not $wslOk) {
    Write-Warn "WSL2 ist nicht eingerichtet. Einmalig ausfuehren und neu starten:"
    Write-Host "    wsl --install" -ForegroundColor White
}

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Err "Docker wurde nicht gefunden."
    Write-Host "  Docker Desktop installieren:" -ForegroundColor White
    Write-Host "    winget install -e --id Docker.DockerDesktop" -ForegroundColor White
    Write-Host "  Danach Docker Desktop starten und dieses Skript erneut ausfuehren." -ForegroundColor White
    exit 1
}

try {
    docker info *> $null
    if ($LASTEXITCODE -ne 0) { throw }
} catch {
    Write-Err "Docker laeuft nicht. Docker Desktop starten und warten, bis das Symbol gruen ist."
    exit 1
}

$composeOk = $false
try { docker compose version *> $null; $composeOk = ($LASTEXITCODE -eq 0) } catch { $composeOk = $false }
if (-not $composeOk) { Write-Err "docker compose fehlt. Docker Desktop aktualisieren."; exit 1 }

$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB)
Write-Step "Arbeitsspeicher im System: $ram GB"
if ($ram -lt 8) { Write-Warn "Unter 8 GB wird es mit Gameservern sehr eng." }
Write-Warn "Docker Desktop teilt WSL2 nur einen Teil des RAM zu. Bei Bedarf %UserProfile%\.wslconfig anpassen."

# --- Verzeichnisse ----------------------------------------------------------
Write-Step "Verzeichnis anlegen: $InstallDir"
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$composeSrc = Join-Path (Split-Path -Parent $scriptDir) "deploy\docker-compose.yml"
if (-not (Test-Path $composeSrc)) {
    Write-Err "deploy\docker-compose.yml nicht gefunden. Projektordner vollstaendig kopieren."
    exit 1
}
Copy-Item $composeSrc (Join-Path $InstallDir "docker-compose.yml") -Force

# --- Konfiguration ----------------------------------------------------------
$envPath = Join-Path $InstallDir ".env"
if (Test-Path $envPath) {
    Write-Step "Vorhandene .env bleibt unveraendert"
} else {
    Write-Step "Geheimnisse erzeugen"
    function New-Secret([int]$bytes = 32) {
        $b = New-Object byte[] $bytes
        [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
        ($b | ForEach-Object { $_.ToString("x2") }) -join ""
    }
    @"
PANEL_IMAGE=$PanelImage
PANEL_PORT=$PanelPort
PANEL_URL=http://localhost:$PanelPort
POSTGRES_DB=panel
POSTGRES_USER=panel
POSTGRES_PASSWORD=$(New-Secret 24)
JWT_SECRET=$(New-Secret 32)
ENCRYPTION_KEY=$(New-Secret 32)
PORT_RANGE=$PortRange
TZ=Europe/Berlin
"@ | Set-Content -Path $envPath -Encoding ASCII
}

# --- Firewall ---------------------------------------------------------------
Write-Step "Firewall-Regeln setzen"
$rules = @(
    @{ Name = "NexusPanel (Web)";      Port = "$PanelPort"; Proto = "TCP" },
    @{ Name = "NexusPanel (Spiel TCP)"; Port = $PortRange;   Proto = "TCP" },
    @{ Name = "NexusPanel (Spiel UDP)"; Port = $PortRange;   Proto = "UDP" }
)
foreach ($r in $rules) {
    if (-not (Get-NetFirewallRule -DisplayName $r.Name -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName $r.Name -Direction Inbound -Action Allow `
            -Protocol $r.Proto -LocalPort $r.Port -Profile Private | Out-Null
        Write-Host "    angelegt: $($r.Name)"
    } else {
        Write-Host "    vorhanden: $($r.Name)"
    }
}

# --- Start ------------------------------------------------------------------
Push-Location $InstallDir
Write-Step "Container starten"
docker compose pull 2>$null
if ($LASTEXITCODE -ne 0) {
    Write-Warn "Panel-Image konnte nicht geladen werden."
    Write-Warn "PANEL_IMAGE in $envPath eintragen, danach: docker compose up -d"
    Write-Step "Postgres und Redis starten trotzdem"
    docker compose up -d postgres redis
} else {
    docker compose up -d
}
Pop-Location

Write-Host ""
Write-Step "Fertig."
Write-Host "  Panel:       http://localhost:$PanelPort"
Write-Host "  Verzeichnis: $InstallDir"
Write-Host "  Logs:        cd $InstallDir; docker compose logs -f panel"
Write-Host ""
Write-Warn "Der Panel-Container steuert Docker. Dieser Rechner sollte niemandem sonst offenstehen."
Write-Warn "Docker Desktop muss bei jedem Windows-Start laufen, sonst sind die Server offline."
