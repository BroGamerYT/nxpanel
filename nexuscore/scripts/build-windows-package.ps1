<#
.SYNOPSIS
  Baut die eigenständige NexusCore.exe (Node SEA) und den NexusCore-Setup.msi Installer für Windows.
.DESCRIPTION
  Erzeugt:
  1. TypeScript-Kompilierung & ESBuild-Bundle (Single File CJS)
  2. Injection in native nexuscore.exe via Node SEA
  3. WiX v5 MSI-Installer-Erstellung (NexusCore-Setup.msi)
#>

$ErrorActionPreference = 'Stop'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Resolve-Path (Join-Path $ScriptDir '..\..')
$NexusCoreDir = Join-Path $ProjectRoot 'nexuscore'

Write-Host "=============================================" -ForegroundColor Cyan
Write-Host "  NexusCore Windows Build (.exe & .msi)" -ForegroundColor Cyan
Write-Host "=============================================" -ForegroundColor Cyan

Set-Location $NexusCoreDir

Write-Host "`n[1/4] TypeScript kompilieren..." -ForegroundColor Yellow
npm run build

Write-Host "`n[2/4] Standalone Bundle mit ESBuild schnüren..." -ForegroundColor Yellow
$esbuild = Join-Path $ProjectRoot 'node_modules\.bin\esbuild.cmd'
& $esbuild dist/index.js --bundle --platform=node --target=node22 --outfile=dist/bundle.cjs --format=cjs --define:process.env.NEXUSCORE_STANDALONE='"1"' --inject:scripts/sea-shim.js --define:import.meta.url=__IMPORT_META_URL

Write-Host "`n[3/4] Native nexuscore.exe (Node SEA) erzeugen..." -ForegroundColor Yellow
Set-Content -Path dist\sea-config.json -Value '{"main": "dist/bundle.cjs", "output": "dist/sea-prep.blob", "disableExperimentalSEAWarning": true}'
node --experimental-sea-config dist\sea-config.json

# Falls nexuscore.exe noch laeuft, informieren oder beenden
$running = Get-Process -Name nexuscore -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "Beende laufende nexuscore.exe Instanz (PID: $($running.Id))..." -ForegroundColor DarkYellow
    Stop-Process -Id $running.Id -Force
    Start-Sleep -Milliseconds 500
}

$seaFuse = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
# Pruefung: ist der Code wirklich in der Exe? (Sicherung umgelegt = ":1", Ressource NODE_SEA_BLOB als UTF-16 vorhanden)
function Test-SeaExe([string]$path) {
    $bytes = [IO.File]::ReadAllBytes($path)
    $ascii = [Text.Encoding]::ASCII.GetString($bytes)
    $utf16 = [Text.Encoding]::Unicode.GetString($bytes)
    return ($ascii.Contains("${seaFuse}:1")) -and (-not $ascii.Contains("${seaFuse}:0")) -and ($utf16.Contains('NODE_SEA_BLOB'))
}

$seaOk = $false
for ($try = 1; $try -le 5 -and -not $seaOk; $try++) {
    Copy-Item (Get-Command node).Source dist\nexuscore.exe -Force
    # Virenscanner und Dateisperren: kurz warten, dann einbauen
    Start-Sleep -Seconds (2 * $try)
    $out = (& npx --yes postject dist\nexuscore.exe NODE_SEA_BLOB dist\sea-prep.blob --sentinel-fuse $seaFuse 2>&1 | Out-String)
    $code = $LASTEXITCODE
    Write-Host $out
    if ($code -eq 0 -and (Test-SeaExe 'dist\nexuscore.exe')) { $seaOk = $true; break }
    $short = ($out -replace '\s+', ' ').Trim()
    Write-Host "::warning::Einbau in nexuscore.exe fehlgeschlagen (Versuch $try, Code $code): $short"
}
if (-not $seaOk) {
    $node = (& node --version)
    Write-Host "::error::nexuscore.exe enthaelt den Core-Code nicht (Node $node, postject-Code $code): $short"
    throw "Der Einbau des Cores in nexuscore.exe ist fehlgeschlagen - der Bau wird abgebrochen."
}
Write-Host "nexuscore.exe enthaelt den Core-Code (geprueft)." -ForegroundColor Green

Write-Host "`n[3.5/4] 1:1 React-Frontend (web/dist) für Standalone kopieren..." -ForegroundColor Yellow
$targetWeb = Join-Path $NexusCoreDir 'dist\web'
if (Test-Path $targetWeb) { Remove-Item $targetWeb -Recurse -Force }
Copy-Item (Join-Path $ProjectRoot 'web\dist') $targetWeb -Recurse -Force

Write-Host "`n[3.8/4] Hilfsprogramme bauen (nxjob: harte Grenzen, nxsvc: Dienst-Huelle)..." -ForegroundColor Yellow
npm run build:helper
npm run build:service

Write-Host "`n[4/4] Windows Installer MSI (WiX v5) erstellen..." -ForegroundColor Yellow
$coreVersion = (Get-Content (Join-Path $NexusCoreDir 'package.json') -Raw | ConvertFrom-Json).version
# Die Exe traegt eine Node-Versionsnummer: bei gleicher Komponenten-GUID haelt MSI die alte Exe fuer gleich/neuer und installiert die neue nicht.
# Darum bekommt die Komponente je Version eine eigene, aus der Version abgeleitete GUID.
$md5 = [System.Security.Cryptography.MD5]::Create()
$exeGuid = [guid]::new($md5.ComputeHash([Text.Encoding]::UTF8.GetBytes("nexuscore-exe-$coreVersion"))).ToString()

wix build -arch x64 -ext WixToolset.UI.wixext -culture de-DE -d CoreVersion=$coreVersion -d ExeGuid=$exeGuid -b $ProjectRoot -b (Join-Path $NexusCoreDir 'deploy\windows') deploy\windows\NexusCore.wxs -o dist\NexusCore-Setup.msi
if ($LASTEXITCODE -ne 0) { throw "wix build ist fehlgeschlagen (Code $LASTEXITCODE) - die MSI ist nicht aktuell." }

Write-Host "`n=============================================" -ForegroundColor Green
Write-Host "  Build erfolgreich abgeschlossen!" -ForegroundColor Green
Write-Host "  EXE: $(Join-Path $NexusCoreDir 'dist\nexuscore.exe')" -ForegroundColor Green
Write-Host "  MSI: $(Join-Path $NexusCoreDir 'dist\NexusCore-Setup.msi')" -ForegroundColor Green
Write-Host "=============================================" -ForegroundColor Green
