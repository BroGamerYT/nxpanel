# NexusCore PowerShell-Startskript fuer Windows
$Host.UI.RawUI.WindowTitle = "NexusCore Host Daemon (Windows)"
Set-Location -Path $PSScriptRoot

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  NEXUSCORE HOST DAEMON - lokaler Windows-Testbetrieb   " -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "Installiere erforderliche Abhaengigkeiten..." -ForegroundColor Green
    npm install
    if ($LASTEXITCODE -ne 0) {
        Write-Host "INSTALLATION FEHLGESCHLAGEN." -ForegroundColor Red
        Read-Host "Beliebige Taste zum Beenden"
        exit 1
    }
}

Write-Host "Baue NexusCore..." -ForegroundColor Green
npm run build
if ($LASTEXITCODE -ne 0) {
    Write-Host "BUILD FEHLGESCHLAGEN." -ForegroundColor Red
    Read-Host "Beliebige Taste zum Beenden"
    exit 1
}

Write-Host ""
Write-Host "Starte Daemon (Beenden mit Strg+C)..." -ForegroundColor Green
Write-Host ""
npm start
