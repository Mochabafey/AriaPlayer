# pack-signed.ps1 — 用自签名证书打包（免费代码签名）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\pack-signed.ps1
# 证书位置：%USERPROFILE%\.ntr-certs\（ntr-self.pfx + password.txt，项目外，不进 git）
# 注意：自签名证书只在导入过信任的机器上消除 SmartScreen 警告；
#       对外公开发布仍需商业/Azure Trusted Signing 证书。

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $env:USERPROFILE '.ntr-certs'
$pfx = Join-Path $certDir 'ntr-self.pfx'
$pwdFile = Join-Path $certDir 'password.txt'

if (-not (Test-Path $pfx) -or -not (Test-Path $pwdFile)) {
  Write-Host "[pack-signed] 未找到证书: $certDir" -ForegroundColor Red
  Write-Host "请先运行 scripts/gen-selfsigned-cert.ps1 生成证书" -ForegroundColor Yellow
  exit 1
}

$env:CSC_LINK = $pfx
$env:CSC_KEY_PASSWORD = (Get-Content $pwdFile -Raw).Trim()
Write-Host "[pack-signed] 使用证书签名: $pfx"
npm run pack:win
