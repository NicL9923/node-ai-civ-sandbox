<#
.SYNOPSIS
  Securely generate + provision World onboarding credentials with a CSPRNG. Never echoes raw secrets.

.DESCRIPTION
  Generates a one-time onboarding token + shared HMAC secret using a cryptographically secure RNG,
  provisions them into Key Vault(s) from files (the `--file` input, never the value passed on the
  command line, which would leak into process args/shell history), and emits ONLY non-secret outputs
  (tokenHash + secret names). Raw material is written to a restricted-ACL temp directory and removed
  after all provisioning succeeds.

  For a locally managed civ (we can reach its dedicated vault), pass -CivVault to also provision the
  onboarding token + HMAC into that civ vault from files. For an external civ whose vault we cannot
  reach, pass -RetainTransferFiles: the secure temp path is returned (non-secret) with a loud
  instruction to transfer the files over an approved secure channel, then clean up via
  scripts/remove-secure-temp.ps1.

.EXAMPLE
  ./scripts/provision-world-onboarding.ps1 -WorldVault nicworldkv123 -HmacSecretName aurora-hmac-v1 `
    -CivVault nic-civ-kv -CivOnboardingSecretName civ-aurora-onboarding-v1 -Subscription <sub>
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$WorldVault,
  [Parameter(Mandatory)][string]$HmacSecretName,
  [string]$Subscription,
  [string]$CivVault,
  [string]$CivHmacSecretName,
  [string]$CivOnboardingSecretName,
  [switch]$RetainTransferFiles
)

$ErrorActionPreference = 'Stop'
if (-not $CivHmacSecretName) { $CivHmacSecretName = $HmacSecretName }

# --- CSPRNG material (cryptographically secure). Uses only APIs available in BOTH Windows PowerShell
#     5.1 (.NET Framework) and PowerShell 7+ (.NET 5+): RandomNumberGenerator.Create().GetBytes,
#     SHA256.Create().ComputeHash, and BitConverter for hex. ---
function ConvertTo-LowerHex([byte[]]$Bytes) {
  return [BitConverter]::ToString($Bytes).Replace('-', '').ToLower()
}

$tokBytes = [byte[]]::new(32)
$hmBytes = [byte[]]::new(48)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
  $rng.GetBytes($tokBytes)
  $rng.GetBytes($hmBytes)
}
finally {
  $rng.Dispose()
}

$onboardingToken = ConvertTo-LowerHex $tokBytes
$hmacSecret = ConvertTo-LowerHex $hmBytes

$sha = [System.Security.Cryptography.SHA256]::Create()
try {
  $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($onboardingToken))
}
finally {
  $sha.Dispose()
}
$tokenHash = ConvertTo-LowerHex $hashBytes

# --- Restricted temp dir (remove inheritance; grant only the current user) ---
$dir = Join-Path $env:TEMP ("world-onboarding-" + [Guid]::NewGuid())
New-Item -ItemType Directory -Path $dir | Out-Null
icacls $dir /inheritance:r /grant:r "$($env:USERNAME):(OI)(CI)F" | Out-Null

$tokenFile = Join-Path $dir 'onboarding-token.txt'
$hmacFile = Join-Path $dir 'hmac-secret.txt'
Set-Content -Path $tokenFile -Value $onboardingToken -NoNewline
Set-Content -Path $hmacFile -Value $hmacSecret -NoNewline

$subArgs = @()
if ($Subscription) { $subArgs = @('--subscription', $Subscription) }

$provisioned = $false
try {
  # World vault: HMAC secret from file. `--output none` prevents az echoing the secret value to logs.
  az keyvault secret set --vault-name $WorldVault --name $HmacSecretName --file $hmacFile --output none @subArgs
  if ($LASTEXITCODE -ne 0) { throw "Failed to set HMAC secret '$HmacSecretName' in World vault '$WorldVault'." }

  if ($CivVault) {
    if (-not $CivOnboardingSecretName) {
      throw "-CivOnboardingSecretName is required when -CivVault is provided."
    }
    az keyvault secret set --vault-name $CivVault --name $CivHmacSecretName --file $hmacFile --output none @subArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to set HMAC secret in civ vault '$CivVault'." }
    az keyvault secret set --vault-name $CivVault --name $CivOnboardingSecretName --file $tokenFile --output none @subArgs
    if ($LASTEXITCODE -ne 0) { throw "Failed to set onboarding token in civ vault '$CivVault'." }
  }
  $provisioned = $true
}
finally {
  # Clean up the raw material ONLY after all provisioning succeeded — unless the caller must transfer
  # it to an external civ, in which case retain the secure path for manual transfer + separate cleanup.
  if ($RetainTransferFiles -and $provisioned) {
    Write-Warning "Transfer files retained (raw onboarding token + HMAC secret): $dir"
    Write-Warning "Transfer them to the external civ over an approved secure channel, then run: scripts/remove-secure-temp.ps1 -Path '$dir'"
  }
  else {
    Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue
  }
}

# Non-secret result only (safe to print/log). The raw token/secret are never returned.
[PSCustomObject]@{
  TokenHash               = $tokenHash
  WorldVault              = $WorldVault
  HmacSecretName          = $HmacSecretName
  CivVault                = $CivVault
  CivOnboardingSecretName = $CivOnboardingSecretName
  RetainedTransferPath    = $(if ($RetainTransferFiles -and $provisioned) { $dir } else { $null })
}
