// =====================================================================================================
// Additive, standalone: a DEDICATED Key Vault for the civilization's World-federation secrets
// (its onboarding token + HMAC secret), with the civ Web App's managed identity granted vault-scoped
// Key Vault Secrets User. A civ-only vault keeps least privilege intact: the civ MI can read its OWN
// secrets but never another civ's, and it never needs access to the World vault.
//
// This template is additive — it references the EXISTING civ Web App (read-only) and never redeploys
// the civilization template or the civ app. It provisions NO secret values (those are set out-of-band
// by scripts/provision-world-onboarding.ps1). Purge protection is unconditionally enabled.
// =====================================================================================================

@description('Azure region for the civ vault. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Tags applied to the civ vault.')
param tags object = {}

@description('Name of the EXISTING civilization Web App whose managed identity will read its secrets.')
param existingCivAppName string = 'nic-node-ai-0706162325'

@description('Globally unique name for the dedicated civ Key Vault (<= 24 chars, alphanumeric + hyphens).')
@maxLength(24)
param civKeyVaultName string = 'niccivkv${take(uniqueString(resourceGroup().id, existingCivAppName), 12)}'

@allowed([
  'Enabled'
  'Disabled'
])
@description('Civ vault public network access. Acceptable to leave Enabled for sandbox.')
param publicNetworkAccess string = 'Enabled'

// Azure RBAC built-in role: "Key Vault Secrets User".
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// Existing civ Web App — read-only reference; its system-assigned identity principal is used below.
resource civApp 'Microsoft.Web/sites@2024-04-01' existing = {
  name: existingCivAppName
}

// Dedicated civ vault: RBAC auth, soft delete, unconditional purge protection, no access policies.
resource civKeyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: civKeyVaultName
  location: location
  tags: tags
  properties: {
    sku: {
      family: 'A'
      name: 'standard'
    }
    tenantId: subscription().tenantId
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 90
    enablePurgeProtection: true
    publicNetworkAccess: publicNetworkAccess
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// Civ MI -> Key Vault Secrets User, scoped to THIS civ-only vault (vault-wide is least privilege here
// because the vault holds only this civ's secrets).
resource civSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(civKeyVault.id, civApp.id, 'kv-secrets-user')
  scope: civKeyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: civApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output civKeyVaultName string = civKeyVault.name
output civKeyVaultUri string = civKeyVault.properties.vaultUri
