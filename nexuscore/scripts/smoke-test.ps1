<#
.SYNOPSIS
  End-to-End-Pruefung des NexusCore auf Windows.

.DESCRIPTION
  Startet den Daemon (falls nicht bereits einer laeuft), prueft alle
  Endpunkte des Protokolls und meldet je Schritt PASS oder FAIL.

  Ohne Parameter startet das Skript einen eigenen Daemon auf Port 18443 mit
  einem zufaellig erzeugten Token. Gegen einen laufenden Daemon prueft man
  mit:
    .\scripts\smoke-test.ps1 -BaseUrl http://127.0.0.1:8443 -Token <token>

  Es werden keine Zugangsdaten gespeichert: das Token existiert nur im
  Speicher dieses Skripts.
#>
param(
  [string]$BaseUrl = '',
  [string]$Token = '',
  [string]$Pin = '',
  [int]$Port = 18443,
  [int]$TimeoutSeconds = 40
)

$ErrorActionPreference = 'Continue'
Set-Location -Path (Join-Path $PSScriptRoot '..')

$script:Passed = 0
$script:Failed = 0
$script:Skipped = 0
$script:StartedDaemon = $null
$script:LogFile = Join-Path $PWD 'data\smoke-daemon.log'

function Write-Step {
  param([string]$Name, [string]$Result, [string]$Detail = '')
  $color = switch ($Result) { 'PASS' { 'Green' } 'FAIL' { 'Red' } default { 'DarkGray' } }
  $line = "  [{0}] {1}" -f $Result, $Name
  if ($Detail) { $line += " - $Detail" }
  Write-Host $line -ForegroundColor $color
  switch ($Result) {
    'PASS' { $script:Passed++ }
    'FAIL' { $script:Failed++ }
    default { $script:Skipped++ }
  }
}

function Invoke-Api {
  param([string]$Method, [string]$Url, [object]$Body = $null, [switch]$NoAuth)
  $headers = @{}
  if (-not $NoAuth -and $Token) { $headers['Authorization'] = "Bearer $Token" }
  $params = @{
    Method = $Method
    Uri = $Url
    Headers = $headers
    ErrorAction = 'Stop'
  }
  # Nur mit Body wird der JSON-Content-Type gesetzt - ein leerer JSON-Body
  # wuerde von Fastify mit einem 400 abgelehnt.
  if ($null -ne $Body) {
    $params['ContentType'] = 'application/json'
    $params['Body'] = ($Body | ConvertTo-Json -Depth 8)
  }
  try {
    $response = Invoke-RestMethod @params
    return @{ Ok = $true; Status = 200; Data = $response; Error = '' }
  } catch {
    $status = 0
    try {
      if ($null -ne $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    } catch { $status = 0 }
    return @{ Ok = $false; Status = $status; Data = $null; Error = "HTTP $status - $($_.Exception.Message)" }
  }
}

Write-Host ''
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host '  NEXUSCORE SMOKE-TEST' -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan

# --- Daemon starten -------------------------------------------------------
if (-not $BaseUrl) {
  if (-not (Test-Path 'dist\index.js')) {
    Write-Host '  Build fehlt - ich baue jetzt ...' -ForegroundColor Yellow
    npm run build | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host '  BUILD FEHLGESCHLAGEN - Smoke-Test abgebrochen.' -ForegroundColor Red
      exit 1
    }
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $PWD 'data') | Out-Null
  if (Test-Path $script:LogFile) { Remove-Item $script:LogFile -Force }

  # Zufallstoken nur fuer diesen Lauf - nichts wird gespeichert.
  # (RandomNumberGenerator::Fill gibt es erst ab .NET Core 2.0, deshalb die
  #  kompatible Variante fuer Windows PowerShell 5.1.)
  $bytes = New-Object byte[] 24
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $Token = [Convert]::ToBase64String($bytes) -replace '\+', '-' -replace '/', '_' -replace '=', ''

  if (-not $Pin) { $Pin = 'SMOKE-TEST' }

  $env:NEXUSCORE_TOKEN = $Token
  $env:NEXUSCORE_PAIRING_PIN = $Pin
  $env:NEXUSCORE_PORT = "$Port"
  $env:NEXUSCORE_HOST = '127.0.0.1'
  $env:NEXUSCORE_MODE = 'test'
  $env:NEXUSCORE_DATA_DIR = 'data/smoke'
  $env:NEXUSCORE_LOG_LEVEL = 'warn'

  $script:StartedDaemon = Start-Process -FilePath 'node' -ArgumentList 'dist/index.js' `
    -WorkingDirectory $PWD -PassThru -WindowStyle Hidden `
    -RedirectStandardOutput $script:LogFile -RedirectStandardError "$script:LogFile.err"

  $BaseUrl = "http://127.0.0.1:$Port"
  Write-Host "  Daemon gestartet (PID $($script:StartedDaemon.Id)) auf $BaseUrl" -ForegroundColor DarkGray

  $ready = $false
  for ($i = 0; $i -lt $TimeoutSeconds; $i++) {
    Start-Sleep -Milliseconds 500
    try {
      Invoke-RestMethod -Uri "$BaseUrl/core/v1/info" -TimeoutSec 2 | Out-Null
      $ready = $true
      break
    } catch { }
  }
  if (-not $ready) {
    Write-Step 'Daemon wird erreichbar' 'FAIL' "Timeout nach $TimeoutSeconds s"
    if (Test-Path $script:LogFile) { Write-Host (Get-Content $script:LogFile -Raw) -ForegroundColor DarkGray }
    exit 1
  }
}
else {
  Write-Host "  Pruefe laufenden Daemon auf $BaseUrl" -ForegroundColor DarkGray
}

Write-Host ''
Write-Host '  Pruefungen:' -ForegroundColor Cyan

# --- 1. /info -------------------------------------------------------------
$res = Invoke-Api -Method GET -Url "$BaseUrl/core/v1/info" -NoAuth
if ($res.Ok -and $res.Data.status -eq 'ok') {
  Write-Step 'GET /core/v1/info ist oeffentlich' 'PASS' ("Host {0}, CPU {1}%" -f $res.Data.host.name, $res.Data.metrics.cpuUsagePercent)
} else {
  Write-Step 'GET /core/v1/info ist oeffentlich' 'FAIL' $res.Error
}

# --- 2. /pair mit falscher PIN -------------------------------------------
$res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/pair" -Body @{ pin = 'ZZZ-ZZZ' } -NoAuth
if ($res.Status -eq 400) { Write-Step 'POST /core/v1/pair lehnt falsche PIN ab' 'PASS' $res.Error }
else { Write-Step 'POST /core/v1/pair lehnt falsche PIN ab' 'FAIL' ("erwartet 400, bekam " + $(if ($res.Ok) { '2xx' } else { $res.Status })) }

# --- 3. /pair mit richtiger PIN ------------------------------------------
if ($Pin) {
  $res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/pair" -Body @{ pin = $Pin } -NoAuth
  if ($res.Ok -and $res.Data.status -eq 'paired') {
    Write-Step 'POST /core/v1/pair mit richtiger PIN' 'PASS' ("Token-Fingerabdruck {0}" -f $res.Data.core.tokenFingerprint)
  } else {
    Write-Step 'POST /core/v1/pair mit richtiger PIN' 'FAIL' $res.Error
  }
} else {
  Write-Step 'POST /core/v1/pair mit richtiger PIN' 'SKIP' 'keine PIN bekannt'
}

# --- 4. geschuetzte Route ohne Token -------------------------------------
$res = Invoke-Api -Method GET -Url "$BaseUrl/core/v1/servers" -NoAuth
if ($res.Status -eq 401) { Write-Step 'GET /core/v1/servers ohne Token -> 401' 'PASS' $res.Error }
else { Write-Step 'GET /core/v1/servers ohne Token -> 401' 'FAIL' ("erwartet 401, bekam " + $(if ($res.Ok) { '2xx' } else { $res.Status })) }

# --- 5. Serverliste mit Token --------------------------------------------
$res = Invoke-Api -Method GET -Url "$BaseUrl/core/v1/servers"
if ($res.Ok) { Write-Step 'GET /core/v1/servers mit Token' 'PASS' ("{0} Instanz(en)" -f $res.Data.servers.Count) }
else { Write-Step 'GET /core/v1/servers mit Token' 'FAIL' $res.Error }

# --- 6. Instanz registrieren ---------------------------------------------
$serverId = "smoke-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$config = @{
  id = $serverId
  name = 'Smoke-Test Server'
  game = 'test'
  executable = $env:ComSpec
  # Der Prozess muss laufen bleiben, sonst gibt es keine Messwerte.
  args = @('/c', 'echo Smoke-Test laeuft. & ping -n 60 127.0.0.1 > nul')
  workingDir = $PWD.Path
  ports = @(@{ name = 'game'; hostPort = 25599; protocol = 'tcp' })
}
$res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/servers" -Body $config
if ($res.Ok) { Write-Step 'POST /core/v1/servers registriert Instanz' 'PASS' $serverId }
else { Write-Step 'POST /core/v1/servers registriert Instanz' 'FAIL' $res.Error }

# --- 7. Duplikat ----------------------------------------------------------
$res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/servers" -Body $config
if ($res.Status -eq 409) { Write-Step 'POST /core/v1/servers lehnt Duplikat ab' 'PASS' $res.Error }
else { Write-Step 'POST /core/v1/servers lehnt Duplikat ab' 'FAIL' ("erwartet 409, bekam " + $(if ($res.Ok) { '2xx' } else { $res.Status })) }

# --- 8. starten -----------------------------------------------------------
$res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/servers/$serverId/start"
if ($res.Ok) { Write-Step 'POST /core/v1/servers/:id/start' 'PASS' ("Status {0}" -f $res.Data.state.status) }
else { Write-Step 'POST /core/v1/servers/:id/start' 'FAIL' $res.Error }

Start-Sleep -Seconds 2

# --- 9. Stats -------------------------------------------------------------
$res = Invoke-Api -Method GET -Url "$BaseUrl/core/v1/servers/$serverId/stats"
if ($res.Ok -and $res.Data.stats.memoryMb -gt 0) {
  Write-Step 'GET /core/v1/servers/:id/stats' 'PASS' ("RAM {0} MB, CPU {1}%, PID {2}" -f $res.Data.stats.memoryMb, $res.Data.stats.cpuPercent, $res.Data.stats.pid)
} elseif ($res.Ok) {
  Write-Step 'GET /core/v1/servers/:id/stats' 'FAIL' ("RAM 0 MB - der Prozess laeuft nicht? Status " + $res.Data.stats.status)
} else {
  Write-Step 'GET /core/v1/servers/:id/stats' 'FAIL' $res.Error
}

# --- 10. Logs -------------------------------------------------------------
$res = Invoke-Api -Method GET -Url "$BaseUrl/core/v1/servers/$serverId/logs?limit=50"
if ($res.Ok -and $res.Data.lines.Count -ge 1) {
  Write-Step 'GET /core/v1/servers/:id/logs' 'PASS' ("{0} Zeile(n)" -f $res.Data.lines.Count)
} elseif ($res.Ok) {
  Write-Step 'GET /core/v1/servers/:id/logs' 'FAIL' 'keine Zeilen empfangen'
} else {
  Write-Step 'GET /core/v1/servers/:id/logs' 'FAIL' $res.Error
}

# --- 11. WebSocket --------------------------------------------------------
$wsUrl = ($BaseUrl -replace '^http', 'ws') + "/core/v1/stream?serverId=$serverId&token=$Token"
$wsOut = & node (Join-Path $PSScriptRoot 'ws-check.mjs') $wsUrl 10000 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Step 'WebSocket /core/v1/stream liefert Ereignisse' 'PASS' ($wsOut | Select-Object -Last 1)
} else {
  Write-Step 'WebSocket /core/v1/stream liefert Ereignisse' 'FAIL' ($wsOut | Select-Object -Last 1)
}

# --- 12. stoppen ----------------------------------------------------------
$res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/servers/$serverId/stop"
if ($res.Ok) { Write-Step 'POST /core/v1/servers/:id/stop' 'PASS' ("Status {0}" -f $res.Data.state.status) }
else { Write-Step 'POST /core/v1/servers/:id/stop' 'FAIL' $res.Error }

# --- 13. unbekannte Instanz ----------------------------------------------
$res = Invoke-Api -Method POST -Url "$BaseUrl/core/v1/servers/gibtsnicht/start"
if ($res.Status -eq 404) { Write-Step 'Unbekannte Instanz -> 404' 'PASS' $res.Error }
else { Write-Step 'Unbekannte Instanz -> 404' 'FAIL' ("erwartet 404, bekam " + $(if ($res.Ok) { '2xx' } else { $res.Status })) }

# --- Aufraeumen -----------------------------------------------------------
if ($script:StartedDaemon) {
  Write-Host ''
  Write-Host '  Stoppe Test-Daemon ...' -ForegroundColor DarkGray
  try { Stop-Process -Id $script:StartedDaemon.Id -Force -ErrorAction SilentlyContinue } catch { }
}

Write-Host ''
Write-Host '========================================================' -ForegroundColor Cyan
Write-Host ("  Ergebnis: {0} PASS, {1} FAIL, {2} SKIP" -f $script:Passed, $script:Failed, $script:Skipped) -ForegroundColor Cyan
Write-Host '========================================================' -ForegroundColor Cyan

if ($script:Failed -gt 0) { exit 1 }
exit 0
