# Downloads the desktop (WPF) version and copies it to C:\Rasyomed\RboxTools (created if missing).
# If that fails for any reason, the files are copied to the Downloads folder instead.
# NOTE: keep this file ASCII-only. It is downloaded with "irm", which can mangle UTF-8 characters.
#
# Usage (PowerShell):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/USER/REPO/main/tools/install-desktop.ps1))) -Repo USER/REPO
param(
    [string]$Repo   = '<USER>/<REPO>',
    [string]$Target = 'C:\Rasyomed\RboxTools',
    [string]$ZipUrl = ''          # for testing only: use another address / file:// path instead of the release
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Repo -like '*<*' -and -not $ZipUrl) { throw 'Give -Repo USER/REPO first.' }

# Fixed release tag "desktop" holds RboxTools-desktop.zip (independent of the agent releases)
$url   = if ($ZipUrl) { $ZipUrl } else { "https://github.com/$Repo/releases/download/desktop/RboxTools-desktop.zip" }
$work  = Join-Path $env:TEMP 'RboxTools-desktop'
$zip   = Join-Path $work 'RboxTools-desktop.zip'
$stage = Join-Path $work 'files'

if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
New-Item -ItemType Directory -Force $work | Out-Null

Write-Host 'Downloading desktop version ...'
Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
Expand-Archive -LiteralPath $zip -DestinationPath $stage -Force

function Get-DownloadsFolder {
    try {
        $p = (New-Object -ComObject Shell.Application).NameSpace('shell:Downloads').Self.Path
        if ($p) { return $p }
    } catch { }
    return (Join-Path $env:USERPROFILE 'Downloads')
}

try {
    # A running app locks its files; stop before copying half of them
    if (Get-Process -Name 'RasyoBOX Araclari' -ErrorAction SilentlyContinue) {
        throw 'RasyoBOX Araclari is running. Close it and run the command again.'
    }
    New-Item -ItemType Directory -Force $Target | Out-Null
    # Existing files with other names (updateFiles, settings) are left untouched
    Copy-Item -Path (Join-Path $stage '*') -Destination $Target -Recurse -Force
    Write-Host "Installed to: $Target" -ForegroundColor Green
    Write-Host "Run: $Target\RasyoBOX Araclari.exe"
}
catch {
    Write-Host "Could not install to $Target : $($_.Exception.Message)" -ForegroundColor Yellow
    $dl = Join-Path (Get-DownloadsFolder) 'RboxTools'
    New-Item -ItemType Directory -Force $dl | Out-Null
    Copy-Item -Path (Join-Path $stage '*') -Destination $dl -Recurse -Force
    Write-Host "Copied to Downloads instead: $dl" -ForegroundColor Green
}
