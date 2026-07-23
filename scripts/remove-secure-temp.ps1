<#
.SYNOPSIS
  Securely remove a temp directory of transferred onboarding secrets (best-effort overwrite + delete).

.DESCRIPTION
  Companion cleanup for scripts/provision-world-onboarding.ps1 -RetainTransferFiles. Overwrites each
  file's bytes with zeros before deleting, then removes the directory. Run this after the raw
  onboarding token + HMAC secret have been transferred to the external civ over a secure channel.

.EXAMPLE
  ./scripts/remove-secure-temp.ps1 -Path "$env:TEMP\world-onboarding-<guid>"
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Path
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Path)) {
  Write-Warning "Path not found (already removed?): $Path"
  return
}

Get-ChildItem -Path $Path -Recurse -File | ForEach-Object {
  $len = (Get-Item $_.FullName).Length
  if ($len -gt 0) {
    $zeros = [byte[]]::new($len)
    [System.IO.File]::WriteAllBytes($_.FullName, $zeros)
  }
}

Remove-Item $Path -Recurse -Force
Write-Host "Securely removed temp directory: $Path"
