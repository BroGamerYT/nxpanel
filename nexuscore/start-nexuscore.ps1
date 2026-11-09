# NexusCore PowerShell Startskript für Windows
$Host.UI.RawUI.WindowTitle = "NexusCore Host Daemon (Windows)"
Set-Location -Path $PSScriptRoot

Write-Host "========================================================" -ForegroundColor Cyan
Write-Host "  ⚡ Starte NexusCore im lokalen Windows Testmodus...   " -ForegroundColor Yellow
Write-Host "========================================================" -ForegroundColor Cyan
Write-Host ""

if (-not (Test-Path "node_modules")) {
    Write-Host "Installiere erforderliche Abhängigkeiten..." -ForegroundColor Green
    npm install
}

Write-Host "Starte NexusCore Daemon..." -ForegroundColor Green
npm run dev
