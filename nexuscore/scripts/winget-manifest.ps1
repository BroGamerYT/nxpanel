# Erzeugt ein winget-Manifest (lokal nutzbar) aus einem GitHub-Release des Cores.
#   .\scripts\winget-manifest.ps1 [-Version 0.3.12] [-Repo BroGamerYT/nxpanel]
# Danach (einmalig als Administrator: winget settings --enable LocalManifestFiles):
#   winget install --manifest nexuscore\dist\winget\<Version>
param(
  [string]$Version = '',
  [string]$Repo = 'BroGamerYT/nxpanel',
  [string]$Id = 'BroGamerYT.NexusCore'
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Version) { $Version = (Get-Content (Join-Path $here '..\package.json') -Raw | ConvertFrom-Json).version }

$rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/tags/core-v$Version"
$asset = $rel.assets | Where-Object name -eq 'NexusCore-Setup.msi' | Select-Object -First 1
if (-not $asset) { throw "Im Release core-v$Version gibt es noch kein NexusCore-Setup.msi (Build fertig?)." }
if ($asset.digest -notmatch '^sha256:([0-9a-f]{64})$') { throw 'GitHub nennt keine SHA-256-Pruefsumme fuer das MSI.' }
$sha = $Matches[1].ToUpper()

$out = Join-Path $here "..\dist\winget\$Version"
New-Item -ItemType Directory -Force $out | Out-Null
$license = (Get-Content (Join-Path $here '..\package.json') -Raw | ConvertFrom-Json).license
$date = ([datetime]$rel.published_at).ToString('yyyy-MM-dd')

$mVersion = @"
PackageIdentifier: $Id
PackageVersion: $Version
DefaultLocale: de-DE
ManifestType: version
ManifestVersion: 1.6.0
"@
$mLocale = @"
PackageIdentifier: $Id
PackageVersion: $Version
PackageLocale: de-DE
Publisher: BroGamerYT
License: $license
PackageName: NexusCore
ShortDescription: Verwaltet Spielserver auf diesem Rechner (Oberflaeche, Kopplung mit dem Panel).
PackageUrl: https://github.com/$Repo
ReleaseNotesUrl: $($rel.html_url)
ManifestType: defaultLocale
ManifestVersion: 1.6.0
"@
$mInstaller = @"
PackageIdentifier: $Id
PackageVersion: $Version
InstallerType: wix
Scope: machine
InstallModes:
- silent
- silentWithProgress
UpgradeBehavior: install
ReleaseDate: $date
Installers:
- Architecture: x64
  InstallerUrl: $($asset.browser_download_url)
  InstallerSha256: $sha
ManifestType: installer
ManifestVersion: 1.6.0
"@
Set-Content (Join-Path $out "$Id.yaml") $mVersion -Encoding utf8
Set-Content (Join-Path $out "$Id.locale.de-DE.yaml") $mLocale -Encoding utf8
Set-Content (Join-Path $out "$Id.installer.yaml") $mInstaller -Encoding utf8
Write-Host "Manifest in $out"
if (Get-Command winget -ErrorAction SilentlyContinue) { winget validate --manifest $out }
Write-Host "Installieren (Administrator): winget install --manifest `"$out`""
