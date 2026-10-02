# Run on the hospital server: downloads the agent from GitHub and starts it (no installation).
# NOTE: this file must stay ASCII-only. It is downloaded with "irm", which can mangle UTF-8 characters.
#
# Usage (PowerShell):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/USER/REPO/main/tools/start-agent.ps1))) -Repo USER/REPO
param(
    [string]$Repo   = '<USER>/<REPO>',
    [string]$Origin = '',         # empty: https://<USER>.github.io
    [string]$Token  = '',         # pairing code chosen by the web page; with it no browser tab is opened
    [string]$ZipUrl = ''          # for testing only: use another address / file:// path instead of the release
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Repo -like '*<*') { throw 'Give -Repo USER/REPO first.' }
if ($Token -and $Token -notmatch '^[A-Za-z0-9-]{4,40}$') { throw 'Invalid -Token.' }
$user = $Repo.Split('/')[0]
$name = $Repo.Split('/')[1]
if (-not $Origin) { $Origin = "https://$user.github.io" }
$pageUrl = "$Origin/$name/"

# Is the .NET 8 runtime installed?
$rt = $null
try { $rt = (& dotnet --list-runtimes 2>$null) -match '^Microsoft\.NETCore\.App 8\.' } catch { }
if (-not $rt) {
    Write-Host '.NET 8 Runtime (Microsoft.NETCore.App 8) was not found.' -ForegroundColor Red
    Write-Host 'Install it from: https://dotnet.microsoft.com/download/dotnet/8.0  (.NET Runtime, x64)' -ForegroundColor Yellow
    Write-Host 'Or download RboxAgent-selfcontained.zip from the Releases page (no .NET needed).' -ForegroundColor Yellow
    return
}

$dir = Join-Path $env:TEMP 'RboxAgent'
New-Item -ItemType Directory -Force $dir | Out-Null
$zip = Join-Path $dir 'RboxAgent.zip'
Write-Host "Downloading latest agent from $Repo ..."
$url = if ($ZipUrl) { $ZipUrl } else { "https://github.com/$Repo/releases/latest/download/RboxAgent.zip" }
Invoke-WebRequest $url -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $dir -Force

$exe = Join-Path $dir 'RboxAgent.exe'
if ($Token) {
    # The page that generated the command is already open and knows the code: connect to it, do not open another tab
    & $exe --origin $Origin --repo $Repo --token $Token --no-browser
} else {
    & $exe --origin $Origin --repo $Repo --open $pageUrl
}
