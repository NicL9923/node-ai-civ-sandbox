@description('Azure region for all resources.')
param location string = resourceGroup().location

@description('Globally unique Linux Web App name.')
param appName string = 'nic-node-ai-${uniqueString(resourceGroup().id)}'

@description('App Service plan SKU name.')
param appServiceSkuName string = 'F1'

@description('App Service plan SKU tier.')
param appServiceSkuTier string = 'Free'

@description('Existing Linux App Service plan resource ID. Leave blank to create a new plan.')
param existingAppServicePlanId string = ''

@description('Globally unique Cosmos DB account name.')
param cosmosAccountName string = 'nicnodeai${uniqueString(resourceGroup().id)}'

@description('Cosmos DB SQL database name.')
param cosmosDatabaseName string = 'sandbox'

@description('Microsoft Foundry account name.')
param aiFoundryName string = 'nic-node-ai-foundry-${uniqueString(resourceGroup().id)}'

@description('Microsoft Foundry project name.')
param aiProjectName string = 'ai-civ-sandbox'

@description('Foundry deployment name for GPT-5.5.')
param gpt55DeploymentName string = 'gpt-5.5'

@description('Foundry deployment name for Claude Sonnet 5.')
param claudeSonnet5DeploymentName string = 'claude-sonnet-5'

@allowed([
  'mock'
  'foundry'
])
@description('AI provider used by the web app at runtime. Use foundry only after model deployments exist.')
param aiProvider string = 'mock'

@secure()
@description('Admin API key for protected start/pause/seed endpoints.')
param adminApiKey string

var appServicePlanName = '${appName}-plan'
var foundryProjectEndpoint = 'https://${aiFoundryName}.services.ai.azure.com/api/projects/${aiProjectName}'
var containers = [
  'simulations'
  'agents'
  'tiles'
  'events'
  'proposals'
  'constitutions'
]

resource plan 'Microsoft.Web/serverfarms@2024-04-01' = if (empty(existingAppServicePlanId)) {
  name: appServicePlanName
  location: location
  sku: {
    name: appServiceSkuName
    tier: appServiceSkuTier
  }
  kind: 'linux'
  properties: {
    reserved: true
  }
}

resource cosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' = {
  name: cosmosAccountName
  location: location
  kind: 'GlobalDocumentDB'
  properties: {
    databaseAccountOfferType: 'Standard'
    publicNetworkAccess: 'Enabled'
    enableFreeTier: false
    consistencyPolicy: {
      defaultConsistencyLevel: 'Session'
    }
    locations: [
      {
        locationName: location
        failoverPriority: 0
        isZoneRedundant: false
      }
    ]
  }
}

resource aiFoundry 'Microsoft.CognitiveServices/accounts@2025-06-01' = {
  name: aiFoundryName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  sku: {
    name: 'S0'
  }
  kind: 'AIServices'
  properties: {
    allowProjectManagement: true
    customSubDomainName: aiFoundryName
    disableLocalAuth: false
  }
}

resource aiProject 'Microsoft.CognitiveServices/accounts/projects@2025-06-01' = {
  parent: aiFoundry
  name: aiProjectName
  location: location
  identity: {
    type: 'SystemAssigned'
  }
  properties: {}
}

resource database 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases@2024-05-15' = {
  parent: cosmos
  name: cosmosDatabaseName
  properties: {
    resource: {
      id: cosmosDatabaseName
    }
  }
}

resource sqlContainers 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = [for containerName in containers: {
  parent: database
  name: containerName
  properties: {
    resource: {
      id: containerName
      partitionKey: {
        paths: [
          containerName == 'simulations' ? '/id' : '/simulationId'
        ]
        kind: 'Hash'
      }
    }
  }
}]

resource app 'Microsoft.Web/sites@2024-04-01' = {
  name: appName
  location: location
  kind: 'app,linux'
  identity: {
    type: 'SystemAssigned'
  }
  properties: {
    serverFarmId: empty(existingAppServicePlanId) ? plan.id : existingAppServicePlanId
    httpsOnly: true
    siteConfig: {
      linuxFxVersion: 'NODE|22-lts'
      appCommandLine: 'npm start'
      alwaysOn: appServiceSkuName != 'F1'
      ftpsState: 'Disabled'
      minTlsVersion: '1.2'
      appSettings: [
        {
          name: 'SCM_DO_BUILD_DURING_DEPLOYMENT'
          value: 'true'
        }
        {
          name: 'SIM_AUTO_START'
          value: 'true'
        }
        {
          name: 'TURN_INTERVAL_MS'
          value: '30000'
        }
        {
          name: 'ACTORS_PER_TURN'
          value: '2'
        }
        {
          name: 'ADMIN_API_KEY'
          value: adminApiKey
        }
        {
          name: 'COSMOS_ENDPOINT'
          value: cosmos.properties.documentEndpoint
        }
        {
          name: 'COSMOS_DATABASE_ID'
          value: cosmosDatabaseName
        }
        {
          name: 'AI_PROVIDER'
          value: aiProvider
        }
        {
          name: 'FOUNDRY_PROJECT_ENDPOINT'
          value: foundryProjectEndpoint
        }
        {
          name: 'GPT55_DEPLOYMENT_NAME'
          value: gpt55DeploymentName
        }
        {
          name: 'CLAUDE_SONNET5_DEPLOYMENT_NAME'
          value: claudeSonnet5DeploymentName
        }
      ]
    }
  }
}

resource cosmosDataContributor 'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments@2024-05-15' = {
  parent: cosmos
  name: guid(cosmos.id, app.id, 'cosmos-data-contributor')
  properties: {
    principalId: app.identity.principalId
    roleDefinitionId: '${cosmos.id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002'
    scope: cosmos.id
  }
}

resource appFoundryUser 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(aiProject.id, app.id, 'foundry-user')
  scope: aiProject
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '53ca6127-db72-4b80-b1b0-d745d6d5456d')
    principalId: app.identity.principalId
    principalType: 'ServicePrincipal'
  }
}

output appName string = app.name
output appUrl string = 'https://${app.properties.defaultHostName}'
output cosmosEndpoint string = cosmos.properties.documentEndpoint
output foundryAccountResourceId string = aiFoundry.id
output foundryProjectEndpoint string = foundryProjectEndpoint
