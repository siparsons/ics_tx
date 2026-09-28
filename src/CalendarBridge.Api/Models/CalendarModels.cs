using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace CalendarBridge.Api.Models;

public sealed record EncryptedEnvelope(int Version, string KeyId, string WrappedKey, string Iv, string Ciphertext);
public sealed record CalendarSnapshot(int Version, string Source, DateTimeOffset CapturedAt,
    DateTimeOffset WindowStart, DateTimeOffset WindowEnd, string Timezone, List<CalendarEvent> Events, string CalendarName = "default");
public sealed record CalendarEvent(string? SourceId, string Title, DateTimeOffset Start,
    DateTimeOffset End, string? Location, bool AllDay);
public sealed record StoredEvent(string Id, string Title, string Location, DateTimeOffset Start,
    DateTimeOffset End, bool AllDay, string? StartDate, string? EndDate, DateTimeOffset Updated);

public static class WireJson
{
    public static readonly JsonSerializerOptions Options = new(JsonSerializerDefaults.Web)
    {
        PropertyNameCaseInsensitive = false,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        MaxDepth = 12,
        Converters = { new OffsetTimestampConverter() }
    };
}

public sealed class OffsetTimestampConverter : JsonConverter<DateTimeOffset>
{
    public override DateTimeOffset Read(ref Utf8JsonReader reader, Type type, JsonSerializerOptions options)
    {
        var s = reader.GetString();
        if (s is null || !Regex.IsMatch(s, @"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$")
            || !DateTimeOffset.TryParse(s, CultureInfo.InvariantCulture, DateTimeStyles.None, out var result))
            throw new JsonException("A timestamp with an explicit UTC offset is required.");
        return result;
    }
    public override void Write(Utf8JsonWriter writer, DateTimeOffset value, JsonSerializerOptions options) =>
        writer.WriteStringValue(value.ToString("O", CultureInfo.InvariantCulture));
}
