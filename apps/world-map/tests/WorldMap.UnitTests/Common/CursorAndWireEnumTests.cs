using System.Text;
using WorldMap.Core.Common;
using WorldMap.Core.Domain;

namespace WorldMap.UnitTests.Common;

public sealed class CursorAndWireEnumTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(42)]
    [InlineData(long.MaxValue)]
    public void CursorCodec_RoundTrips(long expected)
    {
        Assert.True(CursorCodec.TryDecode(CursorCodec.Encode(expected), out var actual));
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    public void CursorCodec_BlankCursor_DecodesToZero(string? cursor)
    {
        Assert.True(CursorCodec.TryDecode(cursor, out var ordinal));
        Assert.Equal(0, ordinal);
    }

    [Theory]
    [InlineData("%%%")]
    [InlineData("a")]
    public void CursorCodec_MalformedBase64_ReturnsFalse(string cursor)
    {
        Assert.False(CursorCodec.TryDecode(cursor, out _));
    }

    [Fact]
    public void CursorCodec_NonJson_ReturnsFalse()
    {
        var cursor = Convert.ToBase64String(Encoding.UTF8.GetBytes("not-json"));
        Assert.False(CursorCodec.TryDecode(cursor, out _));
    }

    [Fact]
    public void CursorCodec_NegativeOrdinal_ReturnsFalse()
    {
        var cursor = Convert.ToBase64String(Encoding.UTF8.GetBytes("""{"o":-1}"""));
        Assert.False(CursorCodec.TryDecode(cursor, out _));
    }

    [Theory]
    [InlineData(null, 50)]
    [InlineData(0, 1)]
    [InlineData(5, 5)]
    [InlineData(999, 200)]
    public void ClampLimit_UsesContractBounds(int? limit, int expected)
    {
        Assert.Equal(expected, Pagination.ClampLimit(limit));
    }

    public static TheoryData<InteractionStatus, string> InteractionWireValues => new()
    {
        { InteractionStatus.Received, "received" },
        { InteractionStatus.Authorized, "authorized" },
        { InteractionStatus.Queued, "queued" },
        { InteractionStatus.Delivered, "delivered" },
        { InteractionStatus.Acknowledged, "acknowledged" },
        { InteractionStatus.Rejected, "rejected" },
        { InteractionStatus.Expired, "expired" },
        { InteractionStatus.Failed, "failed" },
    };

    [Theory]
    [MemberData(nameof(InteractionWireValues))]
    public void InteractionStatus_ToWire(InteractionStatus status, string expected) =>
        Assert.Equal(expected, status.ToWire());

    public static TheoryData<CommandAckStatus, string> AckWireValues => new()
    {
        { CommandAckStatus.Applied, "applied" },
        { CommandAckStatus.Rejected, "rejected" },
        { CommandAckStatus.Duplicate, "duplicate" },
    };

    [Theory]
    [MemberData(nameof(AckWireValues))]
    public void CommandAckStatus_ToWire(CommandAckStatus status, string expected) =>
        Assert.Equal(expected, status.ToWire());

    public static TheoryData<EventIngestStatus, string> EventWireValues => new()
    {
        { EventIngestStatus.Accepted, "accepted" },
        { EventIngestStatus.Duplicate, "duplicate" },
        { EventIngestStatus.Rejected, "rejected" },
    };

    [Theory]
    [MemberData(nameof(EventWireValues))]
    public void EventIngestStatus_ToWire(EventIngestStatus status, string expected) =>
        Assert.Equal(expected, status.ToWire());

    [Theory]
    [InlineData("applied", CommandAckStatus.Applied)]
    [InlineData("rejected", CommandAckStatus.Rejected)]
    [InlineData("duplicate", CommandAckStatus.Duplicate)]
    public void TryParseAckStatus_ValidValue_ReturnsTrue(string value, CommandAckStatus expected)
    {
        Assert.True(WireEnum.TryParseAckStatus(value, out var actual));
        Assert.Equal(expected, actual);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("APPLIED")]
    [InlineData("unknown")]
    public void TryParseAckStatus_InvalidValue_ReturnsFalse(string? value)
    {
        Assert.False(WireEnum.TryParseAckStatus(value, out _));
    }
}
