# Run on the hospital server: downloads the agent from GitHub and starts it (no installation).
# NOTE: this file must stay ASCII-only. It is downloaded with "irm", which can mangle UTF-8 characters.
#
# Usage (PowerShell):
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/USER/REPO/main/tools/start-agent.ps1))) -Repo USER/REPO
param(
    [string]$Repo   = '<USER>/<REPO>',
    [string]$Origin = ''          # empty: https://<USER>.github.io
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Repo -like '*<*') { throw 'Give -Repo USER/REPO first.' }
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
Invoke-WebRequest "https://github.com/$Repo/releases/latest/download/RboxAgent.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $dir -Force

$exe = Join-Path $dir 'RboxAgent.exe'
& $exe --origin $Origin --open $pageUrl
