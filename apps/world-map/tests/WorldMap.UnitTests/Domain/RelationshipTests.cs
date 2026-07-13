using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Domain;

public sealed class RelationshipTests
{
    private static readonly DateTimeOffset Now = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Theory]
    [InlineData(10, 11, true)]  // distinct higher sequence → applies
    [InlineData(10, 9, true)]   // distinct LOWER sequence → still applies (order-independent, exactly-once)
    [InlineData(10, 10, false)] // same sequence → idempotent no-op
    public void ApplyContact_AppliesEachDistinctWorldSequenceExactlyOnce(long incoming, long replay, bool expectedApplied)
    {
        var relationship = Relationship.CreateNeutral("z", "a", Now);
        Assert.True(RelationshipMath.ApplyContact(relationship, incoming, Now));
        var familiarity = relationship.Familiarity;

        var changed = RelationshipMath.ApplyContact(relationship, replay, Now.AddMinutes(1));

        Assert.Equal(expectedApplied, changed);
        Assert.Equal(expectedApplied ? familiarity + 0.10 : familiarity, relationship.Familiarity, 10);
        Assert.True(relationship.HasApplied(incoming));
        Assert.Equal(expectedApplied || replay == incoming, relationship.HasApplied(replay));
    }

    [Fact]
    public void ApplyMessage_ReplayOfSameSequenceIsNoOpAndNarrativeIsStable()
    {
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", Now);
        Assert.True(RelationshipMath.ApplyMessage(relationship, 42, "Aurora", "Trade", Now));

        Assert.False(RelationshipMath.ApplyMessage(relationship, 42, "Changed", "Changed", Now.AddDays(1)));
        Assert.Equal(0.02, relationship.Familiarity, 10);
        Assert.Equal("Aurora sent a public message: \"Trade\".", relationship.NarrativeSummary);
        Assert.True(relationship.HasApplied(42));
    }

    [Fact]
    public void Mutations_ClampBoundsAndBecomeFriendlyAtThreshold()
    {
        var relationship = Relationship.CreateNeutral("a", "b", Now);
        relationship.Familiarity = 0.59;
        relationship.Trust = 10;
        relationship.Grievance = -1;
        relationship.Threat = 101;
        relationship.Interdependence = 4;

        Assert.True(RelationshipMath.ApplyContact(relationship, 1, Now));

        Assert.Equal(1, relationship.Trust);
        Assert.Equal(0, relationship.Grievance);
        Assert.Equal(100, relationship.Threat);
        Assert.Equal(1, relationship.Interdependence);
        Assert.Equal(0.69, relationship.Familiarity, 10);
        Assert.Equal("wary", relationship.Stance);

        relationship.Threat = 0;
        Assert.True(RelationshipMath.ApplyContact(relationship, 2, Now));
        Assert.Equal("friendly", relationship.Stance);
    }

    [Fact]
    public void PairIdentity_IsCanonical()
    {
        Assert.Equal(("a", "z"), Relationship.Canonicalize("z", "a"));
        Assert.Equal(Relationship.PairKeyFor("z", "a"), Relationship.PairKeyFor("a", "z"));
    }
}
