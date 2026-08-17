# gen-selfsigned-cert.ps1 - generate self-signed code signing cert (free)
# Usage: powershell -ExecutionPolicy Bypass -File scripts\gen-selfsigned-cert.ps1
# Output: %USERPROFILE%\.ntr-certs\ntr-self.pfx (private key + password, outside project) + ntr-self.cer (public)
# The cert is also imported to current user trusted root (no SmartScreen warning on this machine).
# NOTE: the private key is sensitive. Never commit it to git or send it to others.

$ErrorActionPreference = 'Stop'
$certDir = Join-Path $env:USERPROFILE '.ntr-certs'
New-Item -ItemType Directory -Path $certDir -Force | Out-Null

# Skip if already exists, to avoid piling up orphan certs
$existing = Get-ChildItem "Cert:\CurrentUser\My" -CodeSigningCert -ErrorAction SilentlyContinue |
  Where-Object { $_.Subject -match 'Aria Player' }
if ($existing) {
  Write-Host "[gen] code signing cert already exists: $($existing[0].Thumbprint), skip"
  if (-not (Test-Path (Join-Path $certDir 'ntr-self.pfx'))) {
    $pass = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
    $sec = ConvertTo-SecureString -String $pass -Force -AsPlainText
    Export-PfxCertificate -Cert $existing[0] -FilePath (Join-Path $certDir 'ntr-self.pfx') -Password $sec | Out-Null
    Export-Certificate -Cert $existing[0] -FilePath (Join-Path $certDir 'ntr-self.cer') | Out-Null
    Set-Content -Path (Join-Path $certDir 'password.txt') -Value $pass -NoNewline
    Write-Host "[gen] re-exported pfx from existing cert"
  }
  exit 0
}

Write-Host "[gen] generating self-signed code signing cert (10y validity)..."
$cert = New-SelfSignedCertificate -Type CodeSigningCert `
  -Subject "CN=Aria Player, O=Aria, C=CN" `
  -KeyAlgorithm RSA -KeyLength 2048 -HashAlgorithm SHA256 `
  -NotAfter (Get-Date).AddYears(10) `
  -CertStoreLocation "Cert:\CurrentUser\My" -KeyExportPolicy Exportable

$pass = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 24 | ForEach-Object {[char]$_})
$sec = ConvertTo-SecureString -String $pass -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath (Join-Path $certDir 'ntr-self.pfx') -Password $sec | Out-Null
Export-Certificate -Cert $cert -FilePath (Join-Path $certDir 'ntr-self.cer') | Out-Null
Set-Content -Path (Join-Path $certDir 'password.txt') -Value $pass -NoNewline

# Import to trusted root: this machine will trust files signed by this cert (no SmartScreen)
certutil -user -addstore Root (Join-Path $certDir 'ntr-self.cer') | Out-Null

Write-Host "[gen] done:"
Write-Host "  cert:   $certDir\ntr-self.pfx"
Write-Host "  public: $certDir\ntr-self.cer"
Write-Host "  thumb:  $($cert.Thumbprint)"
Write-Host "  imported to current user trusted root"
Write-Host "pack signed: powershell -ExecutionPolicy Bypass -File scripts\pack-signed.ps1"
