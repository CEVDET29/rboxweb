# Web arayüzünün giriş şifresini değiştirir (site\js\config.js içindeki SHA-256 özetini günceller).
# Kullanım:  .\set-password.ps1
$secure = Read-Host "Yeni şifre" -AsSecureString
$plain  = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
if ([string]::IsNullOrEmpty($plain)) { Write-Host "Boş şifre girilmedi; değişiklik yapılmadı."; exit 1 }
$sha = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($plain))).Replace('-','').ToLower()
$file = Join-Path $PSScriptRoot "..\site\js\config.js"
$text = [IO.File]::ReadAllText($file, [Text.Encoding]::UTF8)
$text = $text -replace 'PASSWORD_SHA256 = "[0-9a-f]*"', "PASSWORD_SHA256 = `"$sha`""
[IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding($false)))
Write-Host "Şifre güncellendi. Değişikliği GitHub'a göndermeyi unutmayın."
