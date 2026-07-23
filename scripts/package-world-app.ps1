<#
.SYNOPSIS
  Package the already-published World app into a checksummed ZIP, retaining the prior artifact.

.DESCRIPTION
  Moves the current world.zip + world.zip.sha256 to world.prev.zip + world.prev.zip.sha256 (so a
  verified rollback artifact is always retained), then creates a fresh ZIP from the publish output and
  writes its SHA-256 to world.zip.sha256. Run `just world-publish` (dotnet publish) first.

.EXAMPLE
  ./scripts/package-world-app.ps1
#>
[CmdletBinding()]
param(
  [string]$PublishDir = './publish/world',
  [string]$OutDir = './publish'
)

$ErrorActionPreference = 'Stop'

$dll = Join-Path $PublishDir 'WorldMap.Api.dll'
if (-not (Test-Path $dll)) {
  throw "No published app at '$PublishDir' (run 'just world-publish' first)."
}

$zip = Join-Path $OutDir 'world.zip'
$sha = "$zip.sha256"
$prevZip = Join-Path $OutDir 'world.prev.zip'
$prevSha = "$prevZip.sha256"

# Preserve the previous artifact AND its checksum together, so a rollback is always verifiable.
if (Test-Path $prevZip) { Remove-Item $prevZip -Force }
if (Test-Path $prevSha) { Remove-Item $prevSha -Force }
if (Test-Path $zip) { Move-Item $zip $prevZip -Force }
if (Test-Path $sha) { Move-Item $sha $prevSha -Force }

Compress-Archive -Path (Join-Path $PublishDir '*') -DestinationPath $zip -Force
$hash = (Get-FileHash $zip -Algorithm SHA256).Hash
Set-Content -Path $sha -Value $hash -NoNewline

Write-Host "Packaged $zip (sha256=$hash)."
if (Test-Path $prevZip) { Write-Host "Previous artifact retained for rollback: $prevZip" }
