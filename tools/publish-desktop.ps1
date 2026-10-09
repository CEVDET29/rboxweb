# Masaustu (WPF) surumunu Release olarak derler ve dist\RboxTools-desktop-<surum>.zip uretir (or. -1.21.0).
# Zip'i GitHub'da "desktop" etiketli release'e yukleyin (bkz. README): install-desktop.ps1 oradaki en yuksek
# surumlu zip'i indirir.
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

# Derleme ciktisinda kalmis olabilecek ayar / guncelleme dosyalari zip'e girmesin
foreach ($n in 'updateFiles', 'settings.json') {
    $p = Join-Path $out $n
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force }
}

# dist\updateFiles varsa zip'e kopyalanir (kaynak klasore dokunulmaz). "Guncelleme Raporu.txt" bu bilgisayarin
# gunlugudur, alinmaz. DIKKAT: wpa_supplicant (Wi-Fi sifresi), JsonSettings (sunucu IP) gibi hastaneye ozel
# bilgiler zip'e girer; zip'i herkese acik bir release'e yuklemeden once dusunun (bkz. README).
$uf = Join-Path $web 'dist\updateFiles'
if (Test-Path -LiteralPath $uf) {
    $dst = Join-Path $out 'updateFiles'
    Copy-Item -LiteralPath $uf -Destination $dst -Recurse
    Get-ChildItem -LiteralPath $dst -Recurse -File | Where-Object { $_.Name -like 'G*ncelleme Raporu.txt' } | Remove-Item -Force
    $n = (Get-ChildItem -LiteralPath $dst -Recurse -File).Count
    Write-Host "updateFiles eklendi ($n dosya)" -ForegroundColor Yellow
}

# Zip adinda surum: RboxTools-desktop-1.21.0.zip (csproj'daki <Version>; dosya surumunun 4. hanesi atilir)
$fv = [version](Get-Item -LiteralPath (Join-Path $out "RasyoBOX Araclari.exe")).VersionInfo.FileVersion
$ver = "$($fv.Major).$($fv.Minor).$([math]::Max(0, $fv.Build))"
$name = "RboxTools-desktop-$ver.zip"

# Eski zip'ler (surumsuz ya da baska surumlu) karismasin diye silinir
$pubDir = Join-Path $web 'dist\public'
New-Item -ItemType Directory -Force $pubDir | Out-Null
foreach ($d in (Join-Path $web 'dist'), $pubDir) {
    Get-ChildItem -LiteralPath $d -File -Filter 'RboxTools-desktop*.zip' | Remove-Item -Force
}

$zip = Join-Path $web "dist\$name"
Compress-Archive -Path (Join-Path $out '*') -DestinationPath $zip
$mb = [math]::Round((Get-Item $zip).Length / 1MB, 1)
Write-Host "Hazir: $zip ($mb MB)"
Write-Host "Surum: $ver"

# Herkese acik release icin updateFiles'siz kopya (ayni ad)
$pub = Join-Path $pubDir $name
Compress-Archive -Path (Get-ChildItem -LiteralPath $out | Where-Object { $_.Name -ne 'updateFiles' }).FullName -DestinationPath $pub
$mb = [math]::Round((Get-Item $pub).Length / 1MB, 1)
Write-Host "Hazir (updateFiles'siz): $pub ($mb MB)"
