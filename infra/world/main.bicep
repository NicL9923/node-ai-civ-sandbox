// =====================================================================================================
// World Map — production Azure infrastructure (sandbox-grade, parameterized).
//
// Provisions a DEDICATED deployment for the World federation runtime (apps/world-map):
//   * Dedicated Linux App Service plan (scale locked to 1) + .NET 10 Web App (system-assigned identity).
//   * Dedicated Application Insights linked to a Log Analytics workspace (existing by resource id, else new).
//   * New Key Vault (RBAC, soft delete, purge protection) for out-of-band HMAC secrets.
//   * The `worldmap` Cosmos SQL database + its 11 containers, created inside an EXISTING (reused) Cosmos
//     account — the runtime authenticates with managed identity (no account keys).
//   * Least-privilege RBAC: World MI -> Cosmos Data Contributor (scoped to the worldmap DB) and
//     Key Vault Secrets User (scoped to the vault).
//
// SECURITY: this template never emits or accepts raw secret VALUES. Onboarding records carry only
// hashes/refs/names; HMAC secret values are provisioned out-of-band (see docs/world-deployment-runbook.md)
// and surfaced to the app via Key Vault references. It does not recreate or modify any civilization
// resource. Idempotent.
//
// The Cosmos container set / partition key / TTL matrix is sourced from ./containers.json, which is kept
// in lockstep with WorldMap.Infrastructure.Cosmos.CosmosContainers by scripts/check-world-infra.mjs.
// =====================================================================================================

@description('Azure region for all resources. Defaults to the resource group location.')
param location string = resourceGroup().location

@description('Tags applied to every resource created by this template.')
param tags object = {}

@description('Globally unique Linux Web App name for the World runtime.')
param worldAppName string = 'nic-world-${uniqueString(resourceGroup().id)}'

@description('App Service plan SKU name (e.g. B1, P0v3). Dedicated to the World; never shared with the civ plan.')
param appServiceSkuName string = 'B1'

@description('App Service plan SKU tier (e.g. Basic, PremiumV3).')
param appServiceSkuTier string = 'Basic'

@description('Linux runtime stack. Verify availability with `az webapp list-runtimes --os linux`.')
param linuxFxVersion string = 'DOTNETCORE|10.0'

@description('Name of the EXISTING Cosmos DB account to reuse. The worldmap database is created inside it.')
param existingCosmosAccountName string = 'nicnodeai0706162325'

@description('Cosmos SQL database name for the World runtime.')
param worldDatabaseName string = 'worldmap'

@allowed([
  'autoscale'
  'manual'
  'serverless'
])
@description('Throughput mode for the worldmap database. Use `serverless` only when the reused account is a serverless account; otherwise database-level shared throughput is provisioned.')
param cosmosThroughputMode string = 'autoscale'

@minValue(1000)
@description('Max autoscale RU/s for the worldmap shared database throughput (used when cosmosThroughputMode = autoscale).')
param cosmosAutoscaleMaxThroughput int = 1000

@minValue(400)
@description('Manual RU/s for the worldmap shared database throughput (used when cosmosThroughputMode = manual).')
param cosmosManualThroughput int = 400

@description('Resource ID of an EXISTING Log Analytics workspace to link Application Insights to. Leave blank to create a new workspace.')
param existingLogAnalyticsWorkspaceResourceId string = ''

@description('Globally unique Key Vault name (<= 24 chars, alphanumeric + hyphens).')
@maxLength(24)
param keyVaultName string = 'nicworldkv${take(uniqueString(resourceGroup().id), 12)}'

@allowed([
  'Enabled'
  'Disabled'
])
@description('Key Vault public network access. Acceptable to leave Enabled for sandbox; Disabled for locked-down environments.')
param keyVaultPublicNetworkAccess string = 'Enabled'

// NOTE: Key Vault purge protection is UNCONDITIONALLY enabled below (no parameter / disable switch),
// per the security baseline — a soft-deleted secret store must not be permanently purged by bypass.

@description('''Operator-preprovisioned onboarding bindings (NON-SECRET). Each object:
  { tokenHash: lowercase-hex SHA-256 of the onboarding token, civId, keyId, secretRef, secretName }.
The HMAC secret VALUE is set out-of-band in Key Vault (secret `secretName`); the app reads it via a
Key Vault reference wired from `secretRef`. Never place raw tokens or secrets here.''')
param onboardingRecords array = []

// ---- Cosmos schema (single source of truth; also asserted by scripts/check-world-infra.mjs) ----
var cosmosSpec = loadJsonContent('containers.json')

// Default hostname is deterministic; computing it here avoids a self-reference on the site resource.
var worldHostName = '${worldAppName}.azurewebsites.net'
var worldBaseUrl = 'https://${worldHostName}/world/v1'

var createWorkspace = empty(existingLogAnalyticsWorkspaceResourceId)

// Deterministic Key Vault URI (usable at deploy start, unlike keyVault.properties.vaultUri which is a
// runtime value). environment().suffixes.keyvaultDns already includes the leading dot and the value
// ends with a trailing slash, so `${keyVaultUri}secrets/<name>/` yields a valid versionless SecretUri.
var keyVaultUri = 'https://${keyVaultName}${environment().suffixes.keyvaultDns}/'

// Cosmos data-plane RBAC built-in role: "Cosmos DB Built-in Data Contributor".
var cosmosDataContributorRoleId = '00000000-0000-0000-0000-000000000002'
// Azure RBAC built-in role: "Key Vault Secrets User".
var keyVaultSecretsUserRoleId = '4633458b-17de-408a-b874-0445c86b69e6'

// --------------------------------------------------------------------------------------------------
// Existing (reused) Cosmos account — read-only reference; never modified/recreated here.
// --------------------------------------------------------------------------------------------------
resource existingCosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: existingCosmosAccountName
}

// --------------------------------------------------------------------------------------------------
// Monitoring: Log Analytics (new when no existing id supplied) + workspace-based Application Insights.
// --------------------------------------------------------------------------------------------------
resource logAnalytics 'Microsoft.OperationalInsights/workspaces@2023-09-01' = if (createWorkspace) {
  name: '${worldAppName}-logs'
  location: location
  tags: tags
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: 30
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${worldAppName}-insights'
  location: location
  kind: 'web'
  tags: tags
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: createWorkspace ? logAnalytics.id : existingLogAnalyticsWorkspaceResourceId
  }
}

// --------------------------------------------------------------------------------------------------
// Key Vault (RBAC, soft delete, purge protection). No access policies; no secret values in-template.
// --------------------------------------------------------------------------------------------------
resource keyVault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  name: keyVaultName
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
    publicNetworkAccess: keyVaultPublicNetworkAccess
    networkAcls: {
      defaultAction: 'Allow'
      bypass: 'AzureServices'
    }
  }
}

// --------------------------------------------------------------------------------------------------
// Cosmos: worldmap database + 11 containers inside the reused account.
//   * Database-level SHARED throughput (autoscale/manual), or omitted for serverless accounts.
//   * Every container: partition key /pk (Hash v2). defaultTtl -1 only on the TTL containers
//     (nonces, idempotency); durable containers carry no default TTL — matching CosmosReadinessProbe.
//   * Default indexing (index-everything) to match the runtime bootstrapper exactly.
// --------------------------------------------------------------------------------------------------
resource worldDatabase 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: existingCosmos
  name: worldDatabaseName
  properties: {
    resource: {
      id: worldDatabaseName
    }
    options: cosmosThroughputMode == 'serverless'
      ? {}
      : (cosmosThroughputMode == 'autoscale'
          ? {
              autoscaleSettings: {
                maxThroughput: cosmosAutoscaleMaxThroughput
              }
            }
          : {
              throughput: cosmosManualThroughput
            })
  }
}

resource worldContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [
  for c in cosmosSpec.containers: {
    parent: worldDatabase
    name: c.name
    properties: {
      resource: union(
        {
          id: c.name
          partitionKey: {
            paths: [
              cosmosSpec.partitionKeyPath
            ]
            kind: 'Hash'
            version: 2
          }
        },
        // TTL containers self-purge via per-item ttl; DefaultTimeToLive -1 enables TTL without a
        // blanket default. Durable containers omit defaultTtl entirely.
        c.ttl ? { defaultTtl: -1 } : {}
      )
    }
  }
]

// --------------------------------------------------------------------------------------------------
// App Service plan (dedicated, scale = 1) + Linux .NET Web App with the World runtime settings.
// --------------------------------------------------------------------------------------------------
resource plan 'Microsoft.Web/serverfarms@2024-04-01' = {
  name: '${worldAppName}-plan'
  location: location
  tags: tags
  sku: {
    name: appServiceSkuName
    tier: appServiceSkuTier
    capacity: 1
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

// Base (static) app settings. Secret-free: Cosmos uses managed identity; telemetry is a connection
// string (semi-public instrumentation), onboarding/secret settings are appended below.
var baseAppSettings = [
  {
    name: 'ASPNETCORE_ENVIRONMENT'
    value: 'Production'
  }
  {
    name: 'WorldMap__WorldBaseUrl'
    value: worldBaseUrl
  }
  {
    name: 'WorldMap__Storage__Provider'
    value: 'Cosmos'
  }
  {
    name: 'WorldMap__Storage__CosmosEndpoint'
    value: existingCosmos.properties.documentEndpoint
  }
  {
    name: 'WorldMap__Storage__DatabaseName'
    value: worldDatabaseName
  }
  {
    name: 'WorldMap__Storage__BootstrapEnabled'
    value: 'false'
  }
  {
    name: 'WorldMap__Storage__AllowInMemoryOutsideDevelopment'
    value: 'false'
  }
  {
    name: 'WorldMap__Storage__SingleWriterLease__Enabled'
    value: 'true'
  }
  {
    name: 'WorldMap__Storage__SingleWriterLease__LeaseDurationSeconds'
    value: '30'
  }
  {
    name: 'WorldMap__Storage__SingleWriterLease__RenewIntervalSeconds'
    value: '10'
  }
  {
    name: 'WorldMap__Telemetry__AzureMonitorConnectionString'
    value: appInsights.properties.ConnectionString
  }
  {
    // ZIP deploy ships a pre-built publish output; never let Oryx rebuild on the server.
    name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
    value: 'false'
  }
]

// Onboarding records flattened to WorldMap__Onboarding__Records__<i>__<Field> settings (non-secret).
// The for-expression must be the direct value of a variable; flatten() then collapses the groups.
var onboardingSettingGroups = [
  for (record, i) in onboardingRecords: [
    {
      name: 'WorldMap__Onboarding__Records__${i}__TokenHash'
      value: record.tokenHash
    }
    {
      name: 'WorldMap__Onboarding__Records__${i}__CivId'
      value: record.civId
    }
    {
      name: 'WorldMap__Onboarding__Records__${i}__KeyId'
      value: record.keyId
    }
    {
      name: 'WorldMap__Onboarding__Records__${i}__SecretRef'
      value: record.secretRef
    }
  ]
]
var onboardingSettings = flatten(onboardingSettingGroups)

// Secret map: WorldMap__Secrets__Map__<secretRef> -> Key Vault reference to `secretName`.
// Versionless SecretUri form (trailing slash => always latest version). keyVaultUri ends with a slash,
// so `${keyVaultUri}secrets/${name}/` yields https://<vault>/secrets/<name>/ with no double slash.
// The secret VALUE must be provisioned in Key Vault out-of-band before the reference resolves.
var secretMapSettings = [
  for record in onboardingRecords: {
    name: 'WorldMap__Secrets__Map__${record.secretRef}'
    value: '@Microsoft.KeyVault(SecretUri=${keyVaultUri}secrets/${record.secretName}/)'
  }
]

resource worldApp 'Microsoft.Web/sites@2024-04-01' = {
  name: worldAppName
  location: location
  kind: 'app,linux'
  tags: tags
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: plan.id
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: linuxFxVersion
      alwaysOn: true
      http20Enabled: true
      minTlsVersion: '1.2'
      ftpsState: 'Disabled'
      // Single-writer lease requires exactly one instance; the readiness probe validates schema + lease.
      healthCheckPath: '/health/ready'
      numberOfWorkers: 1
      appSettings: concat(baseAppSettings, onboardingSettings, secretMapSettings)
    }
  }
}

// --------------------------------------------------------------------------------------------------
// RBAC (least privilege).
//   * World MI -> Cosmos Data Contributor, scoped to the worldmap DB (data-plane scope /dbs/<db>).
//   * World MI -> Key Vault Secrets User, scoped to the vault.
// --------------------------------------------------------------------------------------------------
resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: existingCosmos
  name: guid(existingCosmos.id, worldApp.id, worldDatabaseName, 'cosmos-data-contributor')
  properties: {
    principalId: worldApp.identity.principalId
    roleDefinitionId: '${existingCosmos.id}/sqlRoleDefinitions/${cosmosDataContributorRoleId}'
    // Cosmos native data-plane RBAC scope. The database-level form is the fully-qualified account
    // resource id + `/dbs/<database>` (documented as a valid data-plane scope by Microsoft Learn:
    // learn.microsoft.com/azure/cosmos-db/nosql — "Grant data plane role-based access"). This is the
    // least-privilege scope: the World MI can read/write only the worldmap DB, not the civ sandbox DB.
    scope: '${existingCosmos.id}/dbs/${worldDatabaseName}'
  }
  dependsOn: [
    worldDatabase
  ]
}

resource keyVaultSecretsUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(keyVault.id, worldApp.id, 'kv-secrets-user')
  scope: keyVault
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', keyVaultSecretsUserRoleId)
    principalId: worldApp.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

// --------------------------------------------------------------------------------------------------
// Outputs (no secret values).
// --------------------------------------------------------------------------------------------------
output worldAppName string = worldApp.name
output worldAppUrl string = 'https://${worldApp.properties.defaultHostName}'
output worldBaseUrl string = worldBaseUrl
output cosmosEndpoint string = existingCosmos.properties.documentEndpoint
output worldDatabaseName string = worldDatabaseName
output keyVaultName string = keyVault.name
output keyVaultUri string = keyVault.properties.vaultUri
output appInsightsName string = appInsights.name
output appInsightsResourceId string = appInsights.id
output worldPrincipalId string = worldApp.identity.principalId
