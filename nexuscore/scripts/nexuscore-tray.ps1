<#
.SYNOPSIS
  NexusCore im Systray: Status, Oberflaeche oeffnen, Kopplungs-PIN kopieren.
.DESCRIPTION
  Laeuft in der Sitzung des angemeldeten Benutzers (ein Dienst darf kein Fenster zeigen) und fragt den Core
  ueber HTTP ab. Die Kopplungs-PIN gibt es nur mit dem Zugriffstoken des Cores (Administrator-Route):
  -Token, die Umgebungsvariable NEXUSCORE_TOKEN oder die Datei -TokenFile (Standard
  %ProgramData%\NexusCore\tray.token, legt install-service.ps1 an). Ohne Token zeigt das Symbol nur den Status.
  Dieses Skript enthaelt bewusst nur ASCII-Zeichen, damit Windows PowerShell 5.1 es ohne BOM richtig liest.
.PARAMETER Check
  Kein Symbol: fragt einmal Status und PIN ab und gibt sie aus (zum Pruefen der Verbindung).
#>
param(
  [string]$Url = 'http://127.0.0.1:8443',
  [string]$Token = $env:NEXUSCORE_TOKEN,
  [string]$TokenFile = (Join-Path $env:ProgramData 'NexusCore\tray.token'),
  [int]$IntervalSeconds = 5,
  [switch]$Check
)

$ErrorActionPreference = 'Stop'
$Url = $Url.TrimEnd('/')

if (-not $Token -and (Test-Path -LiteralPath $TokenFile)) {
  try { $Token = (Get-Content -LiteralPath $TokenFile -Raw).Trim() } catch { $Token = $null }
}

function Get-CoreStatus {
  try {
    $info = Invoke-RestMethod -Uri "$Url/core/v1/info" -TimeoutSec 3
    return @{ Online = $true; Version = [string]$info.core.version; Text = "online (Version $($info.core.version))" }
  } catch {
    return @{ Online = $false; Version = ''; Text = 'nicht erreichbar' }
  }
}

function Invoke-Admin([string]$Method, [string]$Path) {
  if (-not $Token) { throw 'Kein Zugriffstoken: -Token, NEXUSCORE_TOKEN oder tray.token fehlt.' }
  Invoke-RestMethod -Method $Method -Uri "$Url$Path" -Headers @{ Authorization = "Bearer $Token" } -TimeoutSec 5
}

if ($Check) {
  $s = Get-CoreStatus
  Write-Output "Status: $($s.Text)"
  if ($s.Online -and $Token) {
    $p = Invoke-Admin 'GET' '/api/v1/admin/pairing'
    Write-Output "PIN: $($p.pin) (gueltig $($p.validForSeconds) Sekunden)"
  } elseif (-not $Token) {
    Write-Output 'PIN: kein Zugriffstoken vorhanden'
  }
  exit $(if ($s.Online) { 0 } else { 1 })
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Nur eine Instanz je Benutzer
$created = $false
$mutex = New-Object System.Threading.Mutex($true, 'Local\NexusCoreTray', [ref]$created)
if (-not $created) { exit 0 }

function New-StatusIcon([System.Drawing.Color]$Color) {
  $bmp = New-Object System.Drawing.Bitmap 16, 16
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)
  $brush = New-Object System.Drawing.SolidBrush $Color
  $g.FillEllipse($brush, 1, 1, 13, 13)
  $g.DrawEllipse([System.Drawing.Pens]::Black, 1, 1, 13, 13)
  $g.Dispose(); $brush.Dispose()
  $handle = $bmp.GetHicon()
  [System.Drawing.Icon]::FromHandle($handle)
}

$iconOnline = New-StatusIcon ([System.Drawing.Color]::LimeGreen)
$iconOffline = New-StatusIcon ([System.Drawing.Color]::Crimson)

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = $iconOffline
$notify.Text = 'NexusCore'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemStatus = $menu.Items.Add('NexusCore: pruefe ...'); $itemStatus.Enabled = $false
$itemOpen = $menu.Items.Add('Oberflaeche oeffnen')
$null = $menu.Items.Add('-')
$itemPin = $menu.Items.Add('Kopplungs-PIN kopieren')
$itemNewPin = $menu.Items.Add('Neue Kopplungs-PIN erzeugen und kopieren')
$null = $menu.Items.Add('-')
$itemQuit = $menu.Items.Add('Symbol beenden (der Core laeuft weiter)')
$notify.ContextMenuStrip = $menu

function Show-Balloon([string]$Title, [string]$Text) {
  $notify.BalloonTipTitle = $Title
  $notify.BalloonTipText = $Text
  $notify.ShowBalloonTip(4000)
}

function Copy-Pin([bool]$Renew) {
  try {
    $r = if ($Renew) { Invoke-Admin 'POST' '/api/v1/admin/pairing/renew' } else { Invoke-Admin 'GET' '/api/v1/admin/pairing' }
    Set-Clipboard -Value $r.pin
    Show-Balloon 'Kopplungs-PIN kopiert' "$($r.pin) - gueltig 10 Minuten"
  } catch {
    Show-Balloon 'PIN nicht verfuegbar' $_.Exception.Message
  }
}

$itemOpen.add_Click({ Start-Process $Url })
$notify.add_DoubleClick({ Start-Process $Url })
$itemPin.add_Click({ Copy-Pin $false })
$itemNewPin.add_Click({ Copy-Pin $true })
$hasToken = [bool]$Token
$itemPin.Enabled = $hasToken
$itemNewPin.Enabled = $hasToken
if (-not $hasToken) { $itemPin.ToolTipText = 'Kein Zugriffstoken (tray.token) vorhanden' }

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(2, $IntervalSeconds) * 1000
$script:lastOnline = $null
$timer.add_Tick({
  $s = Get-CoreStatus
  $itemStatus.Text = "NexusCore: $($s.Text)"
  $notify.Text = ("NexusCore: $($s.Text)").Substring(0, [Math]::Min(63, ("NexusCore: $($s.Text)").Length))
  $notify.Icon = if ($s.Online) { $iconOnline } else { $iconOffline }
  if ($null -ne $script:lastOnline -and $script:lastOnline -ne $s.Online) {
    Show-Balloon 'NexusCore' $(if ($s.Online) { 'Der Core ist wieder erreichbar.' } else { 'Der Core ist nicht mehr erreichbar.' })
  }
  $script:lastOnline = $s.Online
})
$timer.Start()
$timer.Interval | Out-Null

$itemQuit.add_Click({
  $timer.Stop()
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

# erster Statusabruf sofort
$s0 = Get-CoreStatus
$itemStatus.Text = "NexusCore: $($s0.Text)"
$notify.Icon = if ($s0.Online) { $iconOnline } else { $iconOffline }
$script:lastOnline = $s0.Online

[System.Windows.Forms.Application]::Run()
$mutex.ReleaseMutex()
