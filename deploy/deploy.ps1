<#
    NexusPanel - Updater
    Packt das Projekt, laedt es auf die VM, baut dort das Image und startet neu.

    Aufruf ueber deploy.bat, nicht direkt.
#>
[CmdletBinding()]
param(
    [ValidateSet('deploy', 'restart', 'stop', 'logs', 'status', 'monitor', 'shell', 'test-games', 'test-games-logs')]
    [string]$Action = 'deploy',
    [switch]$SkipTests,
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$RemainingArgs
)

if ($Action -eq 'test-games' -and $RemainingArgs -contains 'logs') {
    $Action = 'test-games-logs'
}

$ErrorActionPreference = 'Stop'
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Step { param($m) Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok   { param($m) Write-Host "    $m" -ForegroundColor Green }
function Write-Warn { param($m) Write-Host "[!] $m" -ForegroundColor Yellow }
function Write-Err  { param($m) Write-Host "[x] $m" -ForegroundColor Red }

# --- Konfiguration ---------------------------------------------------------
$ConfigPath = Join-Path $PSScriptRoot 'deploy.config.json'
if (-not (Test-Path $ConfigPath)) {
    Write-Err "deploy.config.json fehlt."
    Write-Host "  Vorlage kopieren und ausfuellen:" -ForegroundColor White
    Write-Host "    copy deploy\deploy.config.example.json deploy\deploy.config.json" -ForegroundColor White
    exit 1
}

$cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json
foreach ($key in @('host', 'user')) {
    if (-not $cfg.$key) { Write-Err "In deploy.config.json fehlt: $key"; exit 1 }
}
$remotePath = if ($cfg.path) { $cfg.path } else { '/opt/nxpanel' }
$sshPort    = if ($cfg.port) { $cfg.port } else { 22 }

$sshArgs = @('-p', "$sshPort")
$scpArgs = @('-P', "$sshPort")
if ($cfg.key) {
    if (-not (Test-Path $cfg.key)) { Write-Err "SSH-Schluessel nicht gefunden: $($cfg.key)"; exit 1 }
    $sshArgs += @('-i', $cfg.key)
    $scpArgs += @('-i', $cfg.key)
}
$target = "$($cfg.user)@$($cfg.host)"

function Invoke-Remote {
    param([string]$Command, [switch]$AsRoot)
    $full = if ($AsRoot -and $cfg.user -ne 'root') { "sudo bash -lc '$Command'" } else { "bash -lc '$Command'" }
    & ssh @sshArgs $target $full
    if ($LASTEXITCODE -ne 0) { throw "Befehl auf dem Server fehlgeschlagen (Code $LASTEXITCODE)" }
}

<#
    Live-Anzeige: ruft im Takt eine Momentaufnahme vom Server ab und zeichnet
    sie neu. Bewusst eine Abfrage pro Takt statt einer offenen Sitzung - so
    stoert ein kurzer Netzaussetzer die Anzeige nicht dauerhaft.
#>
function Start-Monitor {
    param([int]$IntervalSeconds = 3)

    Write-Host "Live-Anzeige - Strg+C beendet" -ForegroundColor Cyan
    Start-Sleep -Milliseconds 400

    $script = "APP_DIR=$remotePath bash $remotePath/current/deploy/remote-status.sh"
    $fails = 0

    while ($true) {
        $out = & ssh @sshArgs $target $script 2>&1

        if ($LASTEXITCODE -ne 0) {
            $fails++
            [Console]::SetCursorPosition(0, 0)
            Clear-Host
            Write-Warn "Server nicht erreichbar (Versuch $fails) - naechster Versuch in $IntervalSeconds s"
            if ($fails -ge 20) { Write-Err "Zwanzig Versuche fehlgeschlagen, Anzeige beendet."; return }
        } else {
            $fails = 0
            Clear-Host
            $out | ForEach-Object { Write-Host $_ }
            Write-Host ""
            Write-Host "  Strg+C beendet - Aktualisierung alle $IntervalSeconds s" -ForegroundColor DarkGray
        }

        Start-Sleep -Seconds $IntervalSeconds
    }
}

<#
    Fuehrt einen Schritt aus und bietet bei Fehlschlag an, ihn mit Enter zu
    wiederholen. Gedacht fuer die Faelle, die sich von selbst erledigen:
    VM noch am Hochfahren, Netz kurz weg, Docker noch nicht bereit.
#>
function Invoke-WithRetry {
    param(
        [scriptblock]$Action,
        [string]$Label,
        [int]$MaxAttempts = 10
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        try {
            & $Action
            return $true
        }
        catch {
            Write-Err "$Label fehlgeschlagen: $($_.Exception.Message)"
        }

        if ($attempt -eq $MaxAttempts) {
            Write-Err "Nach $MaxAttempts Versuchen aufgegeben."
            return $false
        }

        Write-Host ""
        Write-Host "  [Enter] nochmal versuchen    [q] + [Enter] abbrechen" -ForegroundColor Yellow
        $answer = Read-Host "  Versuch $attempt von $MaxAttempts"
        if ($answer -match '^[qQnN]') { Write-Warn "Abgebrochen."; return $false }
        Write-Step "Versuch $($attempt + 1)"
    }
    return $false
}

if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
    Write-Err "ssh fehlt. Unter Windows nachinstallieren:"
    Write-Host "    Add-WindowsCapability -Online -Name OpenSSH.Client~~~~0.0.1.0" -ForegroundColor White
    exit 1
}

# --- Kurzbefehle -----------------------------------------------------------
switch ($Action) {
    'restart' {
        Write-Step "Neustart auf $($cfg.host)"
        Invoke-Remote "cd $remotePath/current && docker compose -p nxpanel --env-file $remotePath/.env -f deploy/docker-compose.yml -f deploy/docker-compose.build.yml restart panel" -AsRoot
        Write-Ok "Neu gestartet."
        exit 0
    }
    'stop' {
        Write-Step "Anhalten auf $($cfg.host)"
        Invoke-Remote "cd $remotePath/current && docker compose -p nxpanel --env-file $remotePath/.env -f deploy/docker-compose.yml down" -AsRoot
        Write-Ok "Gestoppt."
        exit 0
    }
    'logs' {
        Write-Step "Logs (Strg+C beendet)"
        & ssh @sshArgs $target "sudo bash -lc 'cd $remotePath/current && docker compose -p nxpanel --env-file $remotePath/.env -f deploy/docker-compose.yml logs -f --tail=100 panel'"
        exit 0
    }
    'status' {
        Write-Step "Zustand auf $($cfg.host)"
        Invoke-Remote "cd $remotePath/current && docker compose -p nxpanel --env-file $remotePath/.env -f deploy/docker-compose.yml ps" -AsRoot
        Invoke-Remote "curl -fsS http://127.0.0.1:8080/readyz || echo 'Panel antwortet nicht'"
        Invoke-Remote "ls -1t $remotePath/releases | head -5"
        exit 0
    }
    'monitor' {
        Start-Monitor
        exit 0
    }
    'shell' {
        & ssh @sshArgs $target
        exit 0
    }
    'test-games' {
        Write-Step "Starte automatischen Spiele-Testlauf im Hintergrund auf $($cfg.host)"
        $modeArg = if ($RemainingArgs -contains 'fresh') { '--mode=fresh' } elseif ($RemainingArgs -contains 'retry-failed') { '--mode=retry-failed' } else { '--mode=resume' }
        $extraArgs = @($modeArg)
        foreach ($arg in $RemainingArgs) {
            if ($arg -like '--cpu=*' -or $arg -like '--ram=*' -or $arg -like '--timeout=*' -or $arg -like '--only=*') {
                $extraArgs += $arg
            }
        }
        $cmdArgs = $extraArgs -join ' '
        Invoke-Remote "docker exec -d nxp-panel node dist/cli/test-all-games.js $cmdArgs" -AsRoot
        Write-Ok "Testlauf gestartet ($cmdArgs)! Er läuft nun vollständig im Hintergrund."
        Write-Host ""
        Write-Host "  Du kannst dich jetzt schlafen legen - der Server testet alle Spiele nacheinander." -ForegroundColor Green
        Write-Host "  Erfolgreiche Spiele werden bei Neustarts/Deploys übersprungen und nicht erneut getestet." -ForegroundColor White
        Write-Host ""
        Write-Host "  Fortschritt live ansehen:" -ForegroundColor Cyan
        Write-Host "    .\deploy.bat test-games-logs" -ForegroundColor White
        Write-Host ""
        Write-Host "  Ergebnis-Bericht im Webinterface:" -ForegroundColor Cyan
        Write-Host "    Im NexusPanel unter Administration -> Spiele-Testbericht" -ForegroundColor White
        exit 0
    }
    'test-games-logs' {
        Write-Step "Live-Stand des Spiele-Testlaufs (Strg+C zum Beenden)"
        & ssh @sshArgs $target "sudo docker exec nxp-panel sh -c 'if [ -f /var/lib/panel/test-reports/test-games.log ]; then tail -n 40 -f /var/lib/panel/test-reports/test-games.log; elif [ -f docs/test-games.log ]; then tail -n 40 -f docs/test-games.log; elif [ -f docs/GAME-INSTALL-TESTS.md ]; then cat docs/GAME-INSTALL-TESTS.md; else echo \"Kein Testlauf aktiv oder noch keine Logs vorhanden.\"; fi'"
        exit 0
    }
}

# --- Deploy ----------------------------------------------------------------
Push-Location $ProjectRoot
$swTotal = [System.Diagnostics.Stopwatch]::StartNew()
try {
    # 0. Abhaengigkeiten da?
    $hasModules  = Test-Path (Join-Path $ProjectRoot 'node_modules')
    $hasVitest   = Test-Path (Join-Path $ProjectRoot 'node_modules\vitest')
    $hasTsc      = Test-Path (Join-Path $ProjectRoot 'node_modules\typescript')

    # Neue Pakete in package.json (z. B. nach einem Update von mir) fehlen
    # sonst still in node_modules - die Tests brechen dann mit
    # "Cannot find package" ab. Darum jedes Paket einzeln pruefen.
    $missing = @()
    if ($hasModules) {
        $pkg = Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json
        foreach ($section in @($pkg.dependencies, $pkg.devDependencies)) {
            if (-not $section) { continue }
            foreach ($name in $section.PSObject.Properties.Name) {
                if (-not (Test-Path (Join-Path $ProjectRoot "node_modules\$name"))) { $missing += $name }
            }
        }
        if ($missing.Count -gt 0) { Write-Warn ("Neue Pakete noch nicht installiert: " + ($missing -join ', ')) }
    }

    if (-not $hasModules -or $missing.Count -gt 0 -or (-not $hasVitest -and -not $SkipTests)) {
        # Fehlende Pakete sind kein Testfehler, sondern ein fehlender Schritt.
        Write-Warn "Abhaengigkeiten unvollstaendig."
        Write-Host "  Jetzt nachinstallieren? [Enter] ja   [q] + [Enter] ueberspringen" -ForegroundColor Yellow
        $answer = Read-Host "  "
        if ($answer -notmatch '^[qQnN]') {
            Write-Step "npm install"
            & npm install
            if ($LASTEXITCODE -ne 0) { Write-Err "npm install fehlgeschlagen."; exit 1 }
            $hasModules = $true
            $hasVitest  = Test-Path (Join-Path $ProjectRoot 'node_modules\vitest')
            $hasTsc     = Test-Path (Join-Path $ProjectRoot 'node_modules\typescript')
            Write-Ok "Installiert."
        }
    }

    # 1. Tests
    if (-not $SkipTests) {
        if ($hasVitest) {
            Write-Step "Tests"
            $dbRunning = $false
            try {
                $client = New-Object System.Net.Sockets.TcpClient
                $iar = $client.BeginConnect("127.0.0.1", 5432, $null, $null)
                $dbRunning = $iar.AsyncWaitHandle.WaitOne(200)
                $client.Close()
            } catch {}

            if ($dbRunning) {
                & npm test --silent
                if ($LASTEXITCODE -ne 0) {
                    Write-Err "Tests fehlgeschlagen. Nichts hochgeladen."
                    Write-Host "  Trotzdem ausspielen: deploy.bat deploy -SkipTests" -ForegroundColor White
                    exit 1
                }
                Write-Ok "Alle Tests bestanden."
            } else {
                Write-Warn "Lokale Test-Datenbank (127.0.0.1:5432) laeuft nicht - DB-Integrationstests uebersprungen."
                & npx vitest run tests/variables.test.ts tests/permissions.test.ts tests/rules.test.ts tests/detect.test.ts tests/version.test.ts tests/steam-tuning.test.ts tests/test-db.test.ts tests/bundled-eggs.test.ts --silent
                if ($LASTEXITCODE -ne 0) {
                    Write-Err "Unit-Tests fehlgeschlagen. Nichts hochgeladen."
                    exit 1
                }
                Write-Ok "Unit-Tests bestanden."
            }
        } else {
            Write-Warn "vitest nicht vorhanden - Tests uebersprungen."
        }
    }

    # 2. Backend & Weboberflaeche lokal bauen (dauert lokal ~1.5 s und spart
    #    den kompletten TypeScript/Vite-Build auf der VM!)
    Write-Step "Backend & Weboberflaeche bauen"
    & npm run build
    if ($LASTEXITCODE -ne 0) { Write-Err "Backend-Build (tsc) fehlgeschlagen. Nichts hochgeladen."; exit 1 }
    Write-Ok "Backend gebaut (dist/)."

    $webPkg = Get-Content (Join-Path $ProjectRoot 'web\package.json') -Raw | ConvertFrom-Json
    $webMissing = @()
    foreach ($section in @($webPkg.dependencies, $webPkg.devDependencies)) {
        if ($section) { foreach ($name in $section.PSObject.Properties.Name) {
            if (-not (Test-Path (Join-Path $ProjectRoot "web\node_modules\$name"))) { $webMissing += $name }
        } }
    }
    if ($webMissing.Count -gt 0) {
        Write-Host "    Pakete der Oberflaeche installieren: $($webMissing -join ', ')" -ForegroundColor DarkGray
        & npm --prefix web ci
        if ($LASTEXITCODE -ne 0) { Write-Err "npm ci in web/ fehlgeschlagen."; exit 1 }
    }
    & npm --prefix web run build
    if ($LASTEXITCODE -ne 0) { Write-Err "Oberflaeche baut nicht. Nichts hochgeladen."; exit 1 }
    Write-Ok "Oberflaeche gebaut (web/dist/)."

    # 3. Konfiguration vollstaendig?
    if ($cfg.host -eq 'HIER_IP_EINTRAGEN' -or -not $cfg.host) {
        Write-Err "In deploy\deploy.config.json fehlt die Adresse der VM."
        Write-Host "  notepad deploy\deploy.config.json" -ForegroundColor White
        exit 1
    }

    # 4. Version und Build-Nummer festhalten
    # Die Version kommt aus package.json (die setze ich bei jeder Auslieferung),
    # die Build-Nummer zaehlt jede erfolgreiche Auslieferung hoch. Beides zeigt
    # das Panel unten links an.
    $pkgVersion = (Get-Content (Join-Path $ProjectRoot 'package.json') -Raw | ConvertFrom-Json).version
    $buildFile  = Join-Path $ProjectRoot 'deploy\build-number.txt'
    $lastBuild  = 0
    if (Test-Path $buildFile) { $lastBuild = [int]((Get-Content $buildFile -Raw).Trim()) }
    $buildNo    = $lastBuild + 1
    $buildInfo  = [ordered]@{ version = $pkgVersion; build = $buildNo; builtAt = (Get-Date).ToString('o') } | ConvertTo-Json -Compress
    # Ohne BOM schreiben - Windows PowerShell 5 setzt sonst eins davor.
    [System.IO.File]::WriteAllText((Join-Path $ProjectRoot 'build-info.json'), $buildInfo, (New-Object System.Text.UTF8Encoding $false))
    Write-Ok "Version $pkgVersion, Build $buildNo"

    # 4. Packen
    Write-Step "Projekt packen"
    $stamp   = Get-Date -Format 'yyyyMMdd-HHmmss'
    $tarName = "nxpanel-$stamp.tgz"
    $tarPath = Join-Path $env:TEMP $tarName

    # .env, Daten und node_modules bleiben hier. Die .env lebt auf dem Server.
    # dist/ und web/dist/ sind fertig gebaut und gehen direkt mit ins Archiv!
    $exclude = @(
        '--exclude=node_modules', '--exclude=.git', '--exclude=data',
        '--exclude=.env', '--exclude=*.tgz',
        '--exclude=deploy/deploy.config.json'
    )
    # install/ muss mit: der Server braucht install-linux.sh fuer die
    # Erstinstallation, wenn dort noch keine .env liegt.
    & tar czf $tarPath @exclude dist src web/dist web/package.json web/package-lock.json migrations tests deploy install eggs docs `
        package.json package-lock.json tsconfig.json vitest.config.ts Dockerfile .dockerignore README.md CHANGELOG.md build-info.json
    if ($LASTEXITCODE -ne 0) { Write-Err "Packen fehlgeschlagen."; exit 1 }

    $sizeKb = [math]::Round((Get-Item $tarPath).Length / 1KB)
    Write-Ok "$tarName ($sizeKb KB)"

    # 5. Hochladen - mit Wiederholung, falls die VM noch nicht bereit ist
    Write-Step "Hochladen auf $($cfg.host)"
    $uploaded = Invoke-WithRetry -Label "Upload" -Action {
        & scp @scpArgs $tarPath "${target}:/tmp/$tarName"
        if ($LASTEXITCODE -ne 0) { throw "scp meldete Code $LASTEXITCODE" }
    }
    if (-not $uploaded) { exit 1 }
    Write-Ok "Uebertragen."

    # 6. Auf dem Server einspielen
    Write-Step "Einspielen und neu starten"
    $deployed = Invoke-WithRetry -Label "Einspielen" -Action {
        Invoke-Remote "mkdir -p $remotePath && tar xzf /tmp/$tarName -C /tmp deploy/remote-update.sh 2>/dev/null; APP_DIR=$remotePath bash /tmp/deploy/remote-update.sh /tmp/$tarName" -AsRoot
    }
    if (-not $deployed) {
        Write-Warn "Die vorherige Fassung laeuft weiter - das Update-Skript springt bei Fehlschlag selbst zurueck."
        exit 1
    }

    Write-Host ""
    # Erst jetzt hochzaehlen: ein abgebrochener Versuch verbraucht keine Nummer.
    Set-Content -Path $buildFile -Value $buildNo -NoNewline
    Write-Ok ("Ausgespielt: Version $pkgVersion, Build $buildNo ($stamp) in {0:mm\:ss} min" -f $swTotal.Elapsed)
    Remove-Item $tarPath -ErrorAction SilentlyContinue

    # 7. Live-Anzeige anbieten
    Write-Host ""
    Write-Host "  [Enter] Live-Anzeige starten    [q] + [Enter] fertig" -ForegroundColor Yellow
    $answer = Read-Host "  "
    if ($answer -notmatch '^[qQnN]') {
        Start-Monitor
    } else {
        Write-Host "  Logs:    deploy.bat logs"
        Write-Host "  Zustand: deploy.bat status"
        Write-Host "  Anzeige: deploy.bat monitor"
    }
}
catch {
    Write-Err $_.Exception.Message
    exit 1
}
finally {
    Pop-Location
}
