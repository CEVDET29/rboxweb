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

# Fixed release tag "desktop" (independent of the agent releases) holds RboxTools-desktop-<version>.zip.
# The highest version is used; an old unversioned RboxTools-desktop.zip counts as version 0.
function Get-DesktopZipUrl {
    $fallback = "https://github.com/$Repo/releases/download/desktop/RboxTools-desktop.zip"
    try {
        $rel = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/tags/desktop" -UseBasicParsing `
                   -Headers @{ 'User-Agent' = 'RboxTools-install' }
    } catch {
        Write-Host "Could not read the release list ($($_.Exception.Message)); trying the old file name." -ForegroundColor Yellow
        return $fallback
    }
    $best = $null; $bestVer = $null
    foreach ($a in $rel.assets) {
        if ($a.name -notmatch '^RboxTools-desktop(-(\d+(\.\d+){1,3}))?\.zip$') { continue }
        $v = if ($Matches[2]) { [version]$Matches[2] } else { [version]'0.0' }
        if ($null -eq $best -or $v -gt $bestVer) { $best = $a; $bestVer = $v }
    }
    if ($null -eq $best) { throw "No RboxTools-desktop zip found in the 'desktop' release of $Repo." }
    Write-Host "Found: $($best.name)"
    return $best.browser_download_url
}

$url   = if ($ZipUrl) { $ZipUrl } else { Get-DesktopZipUrl }
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
    # The zip may carry an updateFiles folder. The hospital's own updateFiles is never overwritten:
    # if one exists, the downloaded copy goes next to it as "updateFiles_downloaded" for manual comparison.
    # Existing files with other names (settings etc.) are left untouched
    Get-ChildItem -LiteralPath $stage | Where-Object { $_.Name -ne 'updateFiles' } |
        Copy-Item -Destination $Target -Recurse -Force
    $zipUf = Join-Path $stage 'updateFiles'
    if (Test-Path -LiteralPath $zipUf) {
        $ufTarget = Join-Path $Target 'updateFiles'
        if (Test-Path -LiteralPath $ufTarget) {
            $side = Join-Path $Target 'updateFiles_downloaded'
            if (Test-Path -LiteralPath $side) { Remove-Item -LiteralPath $side -Recurse -Force }
            Copy-Item -LiteralPath $zipUf -Destination $side -Recurse
            Write-Host "Existing updateFiles left untouched. Downloaded copy: $side" -ForegroundColor Yellow
        } else {
            Copy-Item -LiteralPath $zipUf -Destination $ufTarget -Recurse
            Write-Host "updateFiles copied to: $ufTarget"
        }
    }
    Write-Host "Installed to: $Target" -ForegroundColor Green
    $ver = (Get-Item -LiteralPath (Join-Path $Target "RasyoBOX Araclari.exe")).VersionInfo.FileVersion
    Write-Host "Version: $ver (also shown in the title bar)" -ForegroundColor Green
    Write-Host "Run: $Target\RasyoBOX Araclari.exe"
}
catch {
    Write-Host "Could not install to $Target : $($_.Exception.Message)" -ForegroundColor Yellow
    $dl = Join-Path (Get-DownloadsFolder) 'RboxTools'
    New-Item -ItemType Directory -Force $dl | Out-Null
    Copy-Item -Path (Join-Path $stage '*') -Destination $dl -Recurse -Force
    Write-Host "Copied to Downloads instead: $dl" -ForegroundColor Green
}
