namespace WorldMap.IntegrationTests.Harness;

/// <summary>
/// Base for integration tests: gives each test method a fresh <see cref="WorldAppFactory"/>
/// (xUnit constructs a new test-class instance per test), so in-memory state and the
/// one-time onboarding token pool are isolated between tests.
/// </summary>
public abstract class WorldTestBase : IAsyncLifetime
{
    protected WorldAppFactory Factory { get; private set; } = null!;
    protected HttpClient Client { get; private set; } = null!;

    public Task InitializeAsync()
    {
        Factory = new WorldAppFactory();
        Client = Factory.CreateClient();
        return Task.CompletedTask;
    }

    public async Task DisposeAsync()
    {
        Client?.Dispose();
        if (Factory is not null)
        {
            await Factory.DisposeAsync();
        }

        GC.SuppressFinalize(this);
    }
}
