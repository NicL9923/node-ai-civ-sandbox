// =====================================================================================================
// Example parameters for infra/world/main.bicep. NO SECRETS.
//
// Fill in the existing-resource values for your target subscription/resource group before deploying,
// then deploy with:
//   az deployment group create -g <rg> --template-file infra/world/main.bicep --parameters infra/world/main.bicepparam
//
// `onboardingRecords` is NON-SECRET (hashes/refs/names only). The HMAC secret VALUES are set in Key
// Vault out-of-band (see docs/world-deployment-runbook.md); this file must never contain a raw token
// or secret. Leave onboardingRecords empty for the first deploy, then re-deploy with records populated
// AFTER the referenced Key Vault secrets exist so the Key Vault references resolve.
// =====================================================================================================

using './main.bicep'

// --- App Service ---
// param worldAppName = 'nic-world-0706162325'
param appServiceSkuName = 'B1'
param appServiceSkuTier = 'Basic'
param linuxFxVersion = 'DOTNETCORE|10.0'

// --- Cosmos (reuse existing account; dedicated worldmap database) ---
param existingCosmosAccountName = 'nicnodeai0706162325'
param worldDatabaseName = 'worldmap'
param cosmosThroughputMode = 'autoscale'
param cosmosAutoscaleMaxThroughput = 1000

// --- Monitoring ---
// Set to the resource ID of the existing civilization Log Analytics workspace to reuse it, e.g.
//   /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.OperationalInsights/workspaces/<name>
// Leave blank to create a new World workspace.
param existingLogAnalyticsWorkspaceResourceId = ''

// --- Key Vault ---
// param keyVaultName = 'nicworldkvXXXXXXXX'
// Purge protection is unconditionally enabled by the template (no parameter).
param keyVaultPublicNetworkAccess = 'Enabled'

// --- Onboarding (NON-SECRET; empty for the first deploy) ---
// Keep records stably sorted by civId; each tokenHash/civId/keyId/secretRef/secretName must be unique.
// tokenHash = lowercase 64-hex SHA-256; secretRef matches [A-Za-z0-9_-]{1,64}; secretName matches
// [0-9A-Za-z-]{1,127}. Never include a raw `token`/`Token` value. (Enforced by scripts/check-world-infra.mjs.)
// Example populated form (uncomment + edit AFTER the Key Vault secret exists):
// param onboardingRecords = [
//   {
//     tokenHash: '<lowercase-hex-sha256-of-onboarding-token>'
//     civId: 'civ_aurora'
//     keyId: 'key_01'
//     secretRef: 'aurora-hmac-v1'
//     secretName: 'aurora-hmac-v1'
//   }
// ]
param onboardingRecords = []
