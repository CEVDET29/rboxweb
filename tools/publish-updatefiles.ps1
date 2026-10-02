# dist\updateFiles klasöründen dist\updateFiles.zip üretir (klasörün kendisine dokunmaz).
# Bu zip GitHub'da "updatefiles" etiketli ön sürüme (pre-release) elle yüklenir; ajan klasör boşsa oradan indirir:
#   https://github.com/<kullanici>/<depo>/releases/download/updatefiles/updateFiles.zip
# Pakete girmeyenler: "Güncelleme Raporu.txt" (günlük) ve *.unix (eski sürümlerin geçici kopyaları).
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$root = Split-Path $PSScriptRoot -Parent
$src  = Join-Path $root 'dist\updateFiles'
$zip  = Join-Path $root 'dist\updateFiles.zip'
if (-not (Test-Path $src)) { throw "Klasör yok: $src" }
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }

$base = (Resolve-Path $src).Path.TrimEnd('\') + '\'
$files = Get-ChildItem -LiteralPath $src -Recurse -File |
    Where-Object { $_.Name -ne ('G' + [char]0x00FC + 'ncelleme Raporu.txt') -and $_.Extension -ne '.unix' }

$fs = [IO.File]::Open($zip, [IO.FileMode]::CreateNew)
$archive = New-Object IO.Compression.ZipArchive($fs, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($f in $files) {
        $rel = $f.FullName.Substring($base.Length).Replace('\', '/')
        [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $f.FullName, $rel, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
    }
} finally { $archive.Dispose(); $fs.Dispose() }

Write-Host ("Hazir: {0} ({1} dosya, {2:N0} KB)" -f $zip, $files.Count, ((Get-Item $zip).Length / 1KB))
