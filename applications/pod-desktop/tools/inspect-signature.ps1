param([Parameter(Mandatory = $true)][string]$Target)

$ErrorActionPreference = 'Stop'
# A build launched from PowerShell 7 can pass its PSModulePath to Windows
# PowerShell. Load this host's built-in modules rather than an incompatible one.
Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Security', 'Microsoft.PowerShell.Security.psd1')) -Force
Import-Module -Name ([System.IO.Path]::Combine($PSHOME, 'Modules', 'Microsoft.PowerShell.Utility', 'Microsoft.PowerShell.Utility.psd1')) -Force
$signature = Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath $Target
@{
  status = [string]$signature.Status
  subject = [string]$signature.SignerCertificate.Subject
} | Microsoft.PowerShell.Utility\ConvertTo-Json -Compress
