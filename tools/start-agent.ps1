# Hastane sunucusunda çalıştırılır: ajanı GitHub'dan indirir ve başlatır (kurulum yok).
# Kullanım (PowerShell):
#   .\start-agent.ps1 -Repo KULLANICI/REPO
# ya da tek satır:
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/KULLANICI/REPO/main/tools/start-agent.ps1))) -Repo KULLANICI/REPO
param(
    [string]$Repo   = '<KULLANICI>/<REPO>',
    [string]$Origin = ''          # boşsa https://<KULLANICI>.github.io kullanılır
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

if ($Repo -like '*<*') { throw "Önce -Repo KULLANICI/REPO verin." }
$user = $Repo.Split('/')[0]
$name = $Repo.Split('/')[1]
if (-not $Origin) { $Origin = "https://$user.github.io" }

# .NET 8 çalışma zamanı var mı?
$rt = (& dotnet --list-runtimes 2>$null) -match '^Microsoft\.NETCore\.App 8\.'
if (-not $rt) {
    Write-Host ".NET 8 Çalışma Zamanı (Microsoft.NETCore.App 8) bulunamadı." -ForegroundColor Red
    Write-Host "Yüklemek için: https://dotnet.microsoft.com/download/dotnet/8.0  (.NET Runtime, x64)" -ForegroundColor Yellow
    Write-Host "Kurmak istemezseniz RboxAgent-selfcontained.zip sürümünü indirin (Releases sayfası)." -ForegroundColor Yellow
    return
}

$dir = Join-Path $env:TEMP 'RboxAgent'
New-Item -ItemType Directory -Force $dir | Out-Null
$zip = Join-Path $dir 'RboxAgent.zip'
Write-Host "İndiriliyor: $Repo (son sürüm)..."
Invoke-WebRequest "https://github.com/$Repo/releases/latest/download/RboxAgent.zip" -OutFile $zip -UseBasicParsing
Expand-Archive $zip -DestinationPath $dir -Force
& (Join-Path $dir 'RboxAgent.exe') --origin $Origin --open "$Origin/$name/"
