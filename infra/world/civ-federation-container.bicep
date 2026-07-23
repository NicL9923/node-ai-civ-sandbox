// =====================================================================================================
// Additive: ensure the `federation` container exists in the EXISTING civilization Cosmos `sandbox`
// database. The P3 World connector reads/writes it (durable outbox / inbox / cursor / directory).
//
// This is intentionally a STANDALONE module so it can be deployed on its own WITHOUT redeploying the
// full civilization template (infra/civilization/main.bicep) or touching the civ app / other containers.
// It is idempotent: if the container already exists with the same partition key, `what-if` shows a no-op.
//
// The partition key (/simulationId) MUST match the civ template's `federation` container definition.
// =====================================================================================================

@description('Name of the EXISTING Cosmos DB account that hosts the civilization sandbox database.')
param existingCosmosAccountName string = 'nicnodeai0706162325'

@description('Name of the EXISTING civilization Cosmos SQL database.')
param existingCivDatabaseName string = 'sandbox'

@description('Federation container name.')
param federationContainerName string = 'federation'

// Existing (reused) account + database — read-only references; never modified/recreated.
resource existingCosmos 'Microsoft.DocumentDB/databaseAccounts@2024-05-15' existing = {
  name: existingCosmosAccountName

  resource existingDatabase 'sqlDatabases' existing = {
    name: existingCivDatabaseName
  }
}

resource federationContainer 'Microsoft.DocumentDB/databaseAccounts/sqlDatabases/containers@2024-05-15' = {
  parent: existingCosmos::existingDatabase
  name: federationContainerName
  properties: {
    resource: {
      id: federationContainerName
      // Matches the civ template: durable per-entity container partitioned by /simulationId.
      partitionKey: {
        paths: [
          '/simulationId'
        ]
        kind: 'Hash'
      }
    }
  }
}

output federationContainerName string = federationContainer.name
