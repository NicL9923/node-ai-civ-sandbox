<#
.SYNOPSIS
  Deploy (or roll back) the packaged World app, verifying the ZIP checksum first and gating on health.

.DESCRIPTION
  1. Verifies the target ZIP against its committed .sha256 BEFORE deploying — throws on a missing
     checksum or a mismatch (never deploys an unverified/tampered artifact).
  2. ZIP-deploys via `az webapp deploy`.
  3. Gates on health: polls BOTH /health (liveness) and /health/ready (readiness) until HTTP 200 within
     bounded deadlines. THROWS on timeout, connection failure, a null response, or a final non-200 — it
     never reports success on an unhealthy app. On failure it points to the retained world.prev.zip and
     the rollback command; it does NOT auto-roll-back.

  Use -Rollback to deploy the retained previous artifact (world.prev.zip, verified against its own
  checksum).

.EXAMPLE
  ./scripts/deploy-world-app.ps1 -Subscription <sub> -ResourceGroup nicolas-node-ai-sandbox -AppName nic-world-xyz
.EXAMPLE
  ./scripts/deploy-world-app.ps1 -Rollback -Subscription <sub> -ResourceGroup nicolas-node-ai-sandbox -AppName nic-world-xyz
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$Subscription,
  [Parameter(Mandatory)][string]$ResourceGroup,
  [Parameter(Mandatory)][string]$AppName,
  [switch]$Rollback,
  [string]$OutDir = './publish',
  [int]$LivenessTries = 30,
  [int]$ReadinessTries = 40,
  [int]$DelaySeconds = 5
)

$ErrorActionPreference = 'Stop'

$zipName = if ($Rollback) { 'world.prev.zip' } else { 'world.zip' }
$zip = Join-Path $OutDir $zipName
$sha = "$zip.sha256"

if (-not (Test-Path $zip)) { throw "Artifact not found: $zip (run 'just world-package' first)." }
if (-not (Test-Path $sha)) { throw "Checksum not found: $sha — refusing to deploy an unverified artifact." }

$expected = (Get-Content $sha -Raw).Trim()
$actual = (Get-FileHash $zip -Algorithm SHA256).Hash
if ($actual -ne $expected) {
  throw "Checksum MISMATCH for $zip (expected $expected, got $actual). Refusing to deploy a tampered artifact."
}

az webapp deploy --subscription $Subscription --resource-group $ResourceGroup --name $AppName --type zip --src-path $zip
if ($LASTEXITCODE -ne 0) {
  throw "az webapp deploy failed for '$AppName'. The prior artifact is retained at $OutDir/world.prev.zip; roll back with: scripts/deploy-world-app.ps1 -Rollback -Subscription $Subscription -ResourceGroup $ResourceGroup -AppName $AppName"
}

function Wait-Healthy {
  param([string]$Url, [int]$Tries, [int]$DelaySec)
  for ($i = 1; $i -le $Tries; $i++) {
    try {
      $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 10
      if ($null -ne $resp -and $resp.StatusCode -eq 200) { return }
    }
    catch { }
    Start-Sleep -Seconds $DelaySec
  }
  throw "Health gate FAILED: $Url did not return HTTP 200 within $($Tries * $DelaySec)s. The app may be unhealthy. The prior artifact is retained at $OutDir/world.prev.zip — roll back with: scripts/deploy-world-app.ps1 -Rollback -Subscription $Subscription -ResourceGroup $ResourceGroup -AppName $AppName"
}

$base = "https://$AppName.azurewebsites.net"
Wait-Healthy -Url "$base/health" -Tries $LivenessTries -DelaySec $DelaySeconds
Wait-Healthy -Url "$base/health/ready" -Tries $ReadinessTries -DelaySec $DelaySeconds

Write-Host "Deployed and HEALTHY: /health=200 and /health/ready=200 for '$AppName'."
