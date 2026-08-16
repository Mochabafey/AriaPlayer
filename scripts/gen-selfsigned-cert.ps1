# gen-selfsigned-cert.ps1 — 生成自签名代码签名证书（免费）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\gen-selfsigned-cert.ps1
# 产物：%USERPROFILE%\.ntr-certs\ntr-self.pfx（私钥+密码，项目外）+ ntr-self.cer（公钥）
# 生成的证书会导入当前用户受信任根（本机 SmartScreen 不再警告）。
# 注意：证书私钥很敏感，切勿提交到 git / 发送给他人。

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $env:USERPROFILE '.ntr-certs'
New-Item -ItemType Directory -Path $certDir -Force | Out-Null

# 已存在则跳过，避免反复生成一堆孤儿证书
$existing = Get-ChildItem "Cert:\CurrentUser\My" -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -match 'Netease Track Resolver' }
if ($existing) {
  Write-Host "[gen] 已存在代码签名证书: $($existing[0].Thumbprint)，跳过生成"
  if (-not (Test-Path (Join-Path $certDir 'ntr-self.pfx'))) {
    $pass = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
    $sec = ConvertTo-SecureString -String $pass -Force -AsPlainText
    Export-PfxCertificate -Cert $existing[0] -FilePath (Join-Path $certDir 'ntr-self.pfx') -Password $sec | Out-Null
    Export-Certificate -Cert $existing[0] -FilePath (Join-Path $certDir 'ntr-self.cer') | Out-Null
    Set-Content -Path (Join-Path $certDir 'password.txt') -Value $pass -NoNewline
    Write-Host "[gen] 已从现有证书重新导出 pfx"
  }
  exit 0
}

Write-Host "[gen] 生成自签名代码签名证书（10 年有效期）..."
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Netease Track Resolver, O=NTR, C=CN" `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(10) `
  -CertStoreLocation "Cert:\CurrentUser\My" -KeyExportPolicy Exportable

$pass = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
$sec = ConvertTo-SecureString -String $pass -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $certDir 'ntr-self.pfx') -Password $sec | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $certDir 'ntr-self.cer') | Out-Null
Set-Content -Path (Join-Path $certDir 'password.txt') -Value $pass -NoNewline

# 导入受信任根：本机从此信任该证书签名的文件（SmartScreen 不再弹窗）
certutil -user -addstore Root (Join-Path $certDir 'ntr-self.cer') | Out-Null

Write-Host "[gen] 完成:"
Write-Host "  证书:   $certDir\ntr-self.pfx"
Write-Host "  公钥:   $certDir\ntr-self.cer"
Write-Host "  指纹:   $($cert.Thumbprint)"
Write-Host "  已导入当前用户受信任根"
Write-Host "打包签名: powershell -ExecutionPolicy Bypass -File scripts\pack-signed.ps1"
