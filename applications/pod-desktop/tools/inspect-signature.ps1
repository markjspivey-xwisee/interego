param([Parameter(Mandatory = $true)][string]$Target)

$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $Target
@{
  status = [string]$signature.Status
  subject = [string]$signature.SignerCertificate.Subject
} | ConvertTo-Json -Compress
