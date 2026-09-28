# Masaustu (WPF) surumunu Release olarak derler ve dist\RboxTools-desktop.zip uretir.
# Zip'i GitHub'da "desktop" etiketli release'e yukleyin (bkz. README): install-desktop.ps1 oradan indirir.
#   .\publish-desktop.ps1
$ErrorActionPreference = 'Stop'
$web  = Split-Path $PSScriptRoot -Parent                                   # ...\RboxWeb
$proj = Join-Path (Split-Path $web -Parent) 'RboxTools\RboxTools\RboxTools.csproj'
if (-not (Test-Path -LiteralPath $proj)) { throw "WPF projesi bulunamadi: $proj" }

$out = Join-Path $web 'dist\desktop'
if (Test-Path -LiteralPath $out) { Remove-Item -LiteralPath $out -Recurse -Force }

# Yalnizca .NET 8 masaustu calisma zamani gerekir (hastane sunucularinda WPF zaten calisiyor)
dotnet publish $proj -c Release -r win-x64 --self-contained false -p:DebugType=none -p:DebugSymbols=false -o $out
if ($LASTEXITCODE -ne 0) { throw 'dotnet publish basarisiz' }

# Hastaneye ozel dosyalar zip'e girmesin
foreach ($n in 'updateFiles', 'settings.json') {
    $p = Join-Path $out $n
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}

$zip = Join-Path $web 'dist\RboxTools-desktop.zip'
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Hazir: $zip ($mb MB)"
