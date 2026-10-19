# Web/ajan yayini tek komutta: ajan surumunu yazar, degisen (izlenen) dosyalari commit eder, main'i gonderir,
# vX.Y.Z etiketini atar ve gonderir (etiket GitHub Actions'ta RboxAgent.zip derlemesini baslatir).
#   .\release.ps1 0.17.2 "Ping: ... (ajan 0.17.2)"
# Izlenmeyen dosyalar (.omc vb.) eklenmez. Ciktisi tek satir ozettir; hata olursa durur.
param(
    [Parameter(Mandatory)][ValidatePattern('^\d+\.\d+\.\d+$')][string]$Version,
    [Parameter(Mandatory)][string]$Message,
    [string]$Trailer = 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$proj = Join-Path $root 'agent\RboxAgent.csproj'
$tag = "v$Version"

function Invoke-Git { & git.exe -C $root @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') basarisiz" } }

if (& git.exe -C $root tag --list $tag) { throw "$tag zaten var" }

# Ajan surumu (degilse yazilir)
$csproj = [IO.File]::ReadAllText($proj)
$new = [regex]::Replace($csproj, '<Version>[^<]*</Version>', "<Version>$Version</Version>")
if ($new -ne $csproj) { [IO.File]::WriteAllText($proj, $new, (New-Object Text.UTF8Encoding $false)) }

Invoke-Git add -u
& git.exe -C $root diff --cached --quiet
if ($LASTEXITCODE -eq 0) { throw 'Commit edilecek degisiklik yok' }

# Mesaj dosyadan (Turkce karakterler bozulmasin)
$msgFile = [IO.Path]::GetTempFileName()
[IO.File]::WriteAllText($msgFile, "$Message`n`n$Trailer`n", (New-Object Text.UTF8Encoding $false))
try { Invoke-Git commit -q -F $msgFile } finally { Remove-Item $msgFile -ErrorAction SilentlyContinue }

Invoke-Git push -q origin main
Invoke-Git tag $tag
Invoke-Git push -q origin $tag
$sha = (& git.exe -C $root rev-parse --short HEAD)
Write-Host "Yayinlandi: $sha, etiket $tag"
