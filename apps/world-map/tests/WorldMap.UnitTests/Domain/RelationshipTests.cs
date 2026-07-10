using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Domain;

public sealed class RelationshipTests
{
    private static readonly DateTimeOffset Start = new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);

    [Fact]
    public void ApplyContact_IncreasesFamiliarityAndVersion()
    {
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", 1, Start);

        RelationshipMath.ApplyContact(relationship, Start.AddMinutes(1));

        Assert.Equal(0.10, relationship.Familiarity, 10);
        Assert.Equal(1, relationship.Version);
        Assert.Equal(Start.AddMinutes(1), relationship.UpdatedAt);
        Assert.Equal("neutral", relationship.Stance);
    }

    [Fact]
    public void ApplyContact_Repeatedly_ClampsAtOne()
    {
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", 1, Start);

        for (var i = 0; i < 20; i++)
        {
            RelationshipMath.ApplyContact(relationship, Start.AddMinutes(i + 1));
        }

        Assert.Equal(1, relationship.Familiarity);
        Assert.Equal(20, relationship.Version);
    }

    [Fact]
    public void ApplyContact_AtFriendlyThreshold_FlipsStance()
    {
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", 1, Start);

        for (var i = 0; i < 6; i++)
        {
            RelationshipMath.ApplyContact(relationship, Start.AddMinutes(i + 1));
        }

        Assert.True(relationship.Familiarity >= RelationshipMath.FriendlyFamiliarityThreshold);
        Assert.Equal("friendly", relationship.Stance);
    }

    [Theory]
    [InlineData("Trade", "Aurora sent a public message: \"Trade\".")]
    [InlineData(null, "Aurora sent a public message.")]
    [InlineData("", "Aurora sent a public message.")]
    public void ApplyMessage_UpdatesNarrativeAndFamiliarity(string? subject, string expectedNarrative)
    {
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", 1, Start);

        RelationshipMath.ApplyMessage(relationship, "Aurora", subject, Start.AddMinutes(1));

        Assert.Equal(0.02, relationship.Familiarity, 10);
        Assert.Equal(expectedNarrative, relationship.NarrativeSummary);
        Assert.Equal(1, relationship.Version);
    }

    [Fact]
    public void ApplyContact_ClampsEveryDimensionToSchemaBounds()
    {
        var relationship = Relationship.CreateNeutral("civ_a", "civ_b", 1, Start);
        relationship.Trust = 4;
        relationship.Grievance = -10;
        relationship.Threat = 500;
        relationship.Familiarity = 3;
        relationship.Interdependence = -2;

        RelationshipMath.ApplyContact(relationship, Start.AddMinutes(1));

        Assert.InRange(relationship.Trust, -1, 1);
        Assert.InRange(relationship.Grievance, 0, 100);
        Assert.InRange(relationship.Threat, 0, 100);
        Assert.InRange(relationship.Familiarity, 0, 1);
        Assert.InRange(relationship.Interdependence, 0, 1);
    }

    [Theory]
    [InlineData("civ_a", "civ_b")]
    [InlineData("civ_b", "civ_a")]
    public void CanonicalizeAndPairKey_OrderCivilizations(string first, string second)
    {
        var pair = Relationship.Canonicalize(first, second);

        Assert.Equal("civ_a", pair.CivA);
        Assert.Equal("civ_b", pair.CivB);
        Assert.Equal("civ_a|civ_b", Relationship.PairKeyFor(first, second));
    }

    [Fact]
    public void CreateNeutral_UsesCanonicalPairAndDefaults()
    {
        var relationship = Relationship.CreateNeutral("civ_z", "civ_a", 7, Start);

        Assert.Equal("civ_a", relationship.CivA);
        Assert.Equal("civ_z", relationship.CivB);
        Assert.Equal("civ_a|civ_z", relationship.PairKey);
        Assert.Equal(0, relationship.Trust);
        Assert.Equal(0, relationship.Familiarity);
        Assert.Equal("neutral", relationship.Stance);
        Assert.Equal(0, relationship.Version);
    }
}
