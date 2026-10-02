# Ajanı tek dosyalık exe olarak derler ve dist\RboxAgent.zip üretir.
#   .\publish-agent.ps1                 -> yalnızca .NET 8 çalışma zamanı gerektirir (küçük)
#   .\publish-agent.ps1 -SelfContained  -> .NET gerektirmez (büyük, ~70 MB); dist\RboxAgent-selfcontained.zip
param([switch]$SelfContained)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$name = if ($SelfContained) { 'RboxAgent-selfcontained' } else { 'RboxAgent' }
$out  = Join-Path $root "dist\$name"
if (Test-Path $out) { Remove-Item -LiteralPath $out -Recurse -Force }

$sc = if ($SelfContained) { 'true' } else { 'false' }
dotnet publish (Join-Path $root 'agent\RboxAgent.csproj') -c Release -r win-x64 --self-contained $sc `
    -p:PublishSingleFile=true -p:IncludeNativeLibrariesForSelfExtract=true -p:DebugType=none -o $out
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish başarısız' }

# Arayüzün bir kopyası da exe'nin yanına: tarayıcı GitHub sayfasından 127.0.0.1'e erişimi engellerse
# (Chrome/Edge yerel ağ izni, kurum politikası) aynı arayüz http://127.0.0.1:47800/ adresinden açılır.
Copy-Item -LiteralPath (Join-Path $root 'site') -Destination (Join-Path $out 'site') -Recurse

$zip = Join-Path $root "dist\$name.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path "$out\RboxAgent.exe", "$out\site" -DestinationPath $zip
Write-Host "Hazır: $zip"
