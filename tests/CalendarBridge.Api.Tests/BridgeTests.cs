using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Crypto;
using CalendarBridge.Api.Ics;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class TestApp : WebApplicationFactory<Program>
{
    public const string ApiKey = "test-upload-key-012345678901234567890123456789";
    public const string Token = "test-feed-token-012345678901234567890123456789";
    public string? WidgetKey { get; init; }
    public readonly RSA Rsa = RSA.Create(4096);
    public readonly string Db = Path.Combine(Path.GetTempPath(), "calendar-bridge-tests", Guid.NewGuid() + ".db");
    public BridgeOptions Options => new(ApiKey, Token, "Work Calendar", Db, Rsa.ExportPkcs8PrivateKeyPem(),
        "primary", ["https://outlook.office.com"], 262144, 90, "full", false);
    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Testing");
        builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["CALENDAR_API_KEY"] = ApiKey, ["CALENDAR_FEED_TOKEN"] = Token,
            ["DAKBOARD_WIDGET_KEY"] = WidgetKey,
            ["CALENDAR_RSA_PRIVATE_KEY"] = Rsa.ExportPkcs8PrivateKeyPem(),
            ["CALENDAR_DB_PATH"] = Db, ["CALENDAR_ALLOWED_ORIGINS"] = "https://outlook.office.com",
            ["CALENDAR_RSA_KEY_ID"] = "primary", ["CALENDAR_MAX_PAYLOAD_BYTES"] = "262144",
            ["CALENDAR_RETENTION_DAYS"] = "90", ["CALENDAR_PRIVACY_MODE"] = "full", ["RENDER"] = "false"
        }));
    }
    public HttpClient Client() => CreateClient(new WebApplicationFactoryClientOptions { BaseAddress = new Uri("https://localhost") });
    public EncryptedEnvelope Encrypt(CalendarSnapshot snapshot) => EncryptBytes(JsonSerializer.SerializeToUtf8Bytes(snapshot, WireJson.Options));
    public EncryptedEnvelope EncryptBytes(byte[] plain, byte[]? aad = null)
    {
        var key = RandomNumberGenerator.GetBytes(32);
        var iv = RandomNumberGenerator.GetBytes(12);
        var cipher = new byte[plain.Length];
        var tag = new byte[16];
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(iv, plain, cipher, tag, aad ?? EnvelopeCrypto.Aad);
        var wrapped = Rsa.Encrypt(key, RSAEncryptionPadding.OaepSHA256);
        CryptographicOperations.ZeroMemory(key);
        return new(1, "primary", EnvelopeCrypto.Encode(wrapped), EnvelopeCrypto.Encode(iv), EnvelopeCrypto.Encode([.. cipher, .. tag]));
    }
    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            Rsa.Dispose();
            SqliteConnection.ClearAllPools();
            foreach (var suffix in new[] { "", "-shm", "-wal" }) if (File.Exists(Db + suffix)) File.Delete(Db + suffix);
        }
    }
}

public sealed class BridgeTests : IClassFixture<TestApp>
{
    private readonly TestApp app;
    public BridgeTests(TestApp app) => this.app = app;
    private static DateTimeOffset Day => new(DateTime.UtcNow.Date.AddDays(1), TimeSpan.Zero);
    private static CalendarEvent Event(string title, int hour = 10) => new(null, title, Day.AddHours(hour), Day.AddHours(hour + 1), "Room", false);
    private static CalendarSnapshot Snapshot(params CalendarEvent[] events) =>
        new(1, SnapshotValidator.Source, DateTimeOffset.UtcNow, Day, Day.AddDays(1), "Europe/London", events.ToList());
    private async Task<HttpResponseMessage> Post(object payload, string? key = TestApp.ApiKey)
    {
        using var client = app.Client();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/calendar/sync") { Content = JsonContent.Create(payload) };
        if (key is not null) request.Headers.Add("X-API-Key", key);
        return await client.SendAsync(request);
    }

    [Fact] public async Task CorrectKeySucceeds()
    {
        var snapshot = Snapshot(Event("Authorized"));
        // Unique window avoids interacting with other integration tests.
        snapshot = snapshot with { WindowStart = Day.AddDays(10), WindowEnd = Day.AddDays(11),
            Events = [Event("Authorized") with { Start = Day.AddDays(10).AddHours(10), End = Day.AddDays(10).AddHours(11) }] };
        Assert.Equal(HttpStatusCode.OK, (await Post(app.Encrypt(snapshot))).StatusCode);
    }
    [Theory]
    [InlineData(null)]
    [InlineData("wrong")]
    public async Task MissingOrIncorrectKeyIsUnauthorized(string? key) =>
        Assert.Equal(HttpStatusCode.Unauthorized, (await Post(app.Encrypt(Snapshot()), key)).StatusCode);

    [Fact] public async Task PlaintextAndUnknownFieldsAreRejected()
    {
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(Snapshot(Event("Secret")))).StatusCode);
        var bytes = Encoding.UTF8.GetBytes(JsonSerializer.Serialize(Snapshot(Event("Secret")), WireJson.Options).Replace("\"version\":1", "\"version\":1,\"meetingBody\":\"forbidden\""));
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(app.EncryptBytes(bytes))).StatusCode);
    }
    [Fact] public void ValidEnvelopeDecrypts()
    {
        using var crypto = new EnvelopeCrypto(app.Options);
        var decoded = crypto.Decrypt(app.Encrypt(Snapshot(Event("Café 😊"))));
        Assert.Equal("Café 😊", decoded.Events[0].Title);
    }
    [Theory]
    [InlineData("cipher")]
    [InlineData("wrapped")]
    [InlineData("keyId")]
    [InlineData("version")]
    [InlineData("iv")]
    [InlineData("aad")]
    public async Task TamperingIsRejected(string kind)
    {
        var envelope = app.Encrypt(Snapshot(Event("Private")));
        byte[] Flip(string value) { var bytes = EnvelopeCrypto.Decode(value); bytes[0] ^= 1; return bytes; }
        envelope = kind switch
        {
            "cipher" => envelope with { Ciphertext = EnvelopeCrypto.Encode(Flip(envelope.Ciphertext)) },
            "wrapped" => envelope with { WrappedKey = EnvelopeCrypto.Encode(Flip(envelope.WrappedKey)) },
            "keyId" => envelope with { KeyId = "unknown" },
            "version" => envelope with { Version = 2 },
            "iv" => envelope with { Iv = EnvelopeCrypto.Encode(new byte[8]) },
            _ => app.EncryptBytes(JsonSerializer.SerializeToUtf8Bytes(Snapshot()), Encoding.UTF8.GetBytes("wrong-aad"))
        };
        Assert.Equal(HttpStatusCode.BadRequest, (await Post(envelope)).StatusCode);
    }
    [Fact] public async Task PublicKeyContainsOnlyPublicMaterial()
    {
        using var client = app.Client();
        using var doc = JsonDocument.Parse(await client.GetStringAsync("/api/v1/crypto/public-key"));
        var jwk = doc.RootElement.GetProperty("jwk");
        Assert.False(jwk.TryGetProperty("d", out _));
        Assert.False(jwk.TryGetProperty("p", out _));
        Assert.Equal("RSA-OAEP-256", jwk.GetProperty("alg").GetString());
        using var pub = RSA.Create();
        pub.ImportParameters(new RSAParameters { Modulus = EnvelopeCrypto.Decode(jwk.GetProperty("n").GetString()!),
            Exponent = EnvelopeCrypto.Decode(jwk.GetProperty("e").GetString()!) });
        Assert.Equal(4096, pub.KeySize);
    }
    [Fact] public async Task FeedTokenAndHealth()
    {
        using var client = app.Client();
        var response = await client.GetAsync("/calendar/" + TestApp.Token + ".ics");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/calendar", response.Content.Headers.ContentType!.MediaType);
        Assert.StartsWith("BEGIN:VCALENDAR\r\n", await response.Content.ReadAsStringAsync());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/calendar/wrong.ics")).StatusCode);
        Assert.Equal("{\"status\":\"ok\"}", await client.GetStringAsync("/health"));
    }
    [Fact] public async Task CorsAllowsOnlyConfiguredOriginAndHeaders()
    {
        using var client = app.Client();
        foreach (var origin in new[] { "https://outlook.office.com", "https://evil.invalid" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Options, "/api/v1/calendar/sync");
            request.Headers.Add("Origin", origin);
            request.Headers.Add("Access-Control-Request-Method", "POST");
            request.Headers.Add("Access-Control-Request-Headers", "content-type,x-api-key");
            var response = await client.SendAsync(request);
            Assert.Equal(origin.Contains("office.com"), response.Headers.Contains("Access-Control-Allow-Origin"));
            Assert.False(response.Headers.Contains("Access-Control-Allow-Credentials"));
        }
    }
    [Fact] public async Task OversizeIncludingUnknownContentLengthIsRejected()
    {
        using var client = app.Client();
        using var request = new HttpRequestMessage(HttpMethod.Post, "/api/v1/calendar/sync");
        request.Headers.Add("X-API-Key", TestApp.ApiKey);
        request.Content = new StreamContent(new NonSeekableStream(new byte[262145]));
        request.Content.Headers.ContentType = new("application/json");
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, (await client.SendAsync(request)).StatusCode);
    }
    [Fact] public async Task PlainHttpFailsEvenWithSpoofedProxyHeader()
    {
        using var client = app.CreateClient(new() { BaseAddress = new Uri("http://localhost") });
        client.DefaultRequestHeaders.Add("X-Forwarded-Proto", "https");
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/v1/crypto/public-key")).StatusCode);
    }

    [Fact] public void SnapshotReplacementIsAtomicAndScoped()
    {
        using var local = new TestApp();
        var store = new CalendarStore(local.Options); store.Initialize();
        var first = Snapshot(Event("A"), Event("B", 11), Event("C", 12)) with { CapturedAt = DateTimeOffset.UtcNow.AddSeconds(-10) };
        var outside = Event("Outside") with { Start = Day.AddDays(2), End = Day.AddDays(2).AddHours(1) };
        store.Replace(Snapshot(outside) with { WindowStart = Day.AddDays(2), WindowEnd = Day.AddDays(3) });
        store.Replace(first);
        var before = store.Read().Single(e => e.Title == "A").Id;
        store.Replace(first with { CapturedAt = DateTimeOffset.UtcNow, Events = [Event("A"), Event("C", 12), Event("D", 13)] });
        Assert.Equal(new[] { "A", "C", "D", "Outside" }, store.Read().Select(e => e.Title));
        Assert.Equal(before, store.Read().Single(e => e.Title == "A").Id);
        Assert.Throws<StaleSnapshotException>(() => store.Replace(first));
        Assert.Equal(4, store.Read().Count);
        // A later empty capture removes exactly the selected window.
        store.Replace(first with { CapturedAt = DateTimeOffset.UtcNow.AddSeconds(1), Events = [] });
        Assert.Equal("Outside", Assert.Single(store.Read()).Title);
    }
    [Fact] public void FailedInsertRollsBackDeletion()
    {
        using var local = new TestApp();
        var store = new CalendarStore(local.Options); store.Initialize();
        store.Replace(Snapshot(Event("Original")) with { CapturedAt = DateTimeOffset.UtcNow.AddSeconds(-1) });
        // Bypass validation deliberately to exercise transaction rollback on a uniqueness failure.
        Assert.Throws<SqliteException>(() => store.Replace(Snapshot(Event("Duplicate"), Event("Duplicate"))));
        Assert.Equal("Original", Assert.Single(store.Read()).Title);
    }
    [Fact] public void HalfOpenWindowAndRetention()
    {
        using var local = new TestApp();
        var store = new CalendarStore(local.Options); store.Initialize();
        var atEnd = Event("Boundary") with { Start = Day.AddDays(1), End = Day.AddDays(1).AddHours(1) };
        store.Replace(Snapshot(atEnd) with { WindowEnd = Day.AddDays(2), CapturedAt = DateTimeOffset.UtcNow.AddSeconds(-1) });
        store.Replace(Snapshot());
        Assert.Equal("Boundary", Assert.Single(store.Read()).Title);
        store.Cleanup(Day.AddDays(100));
        Assert.Empty(store.Read());
    }
    [Theory]
    [InlineData("full", true, true)]
    [InlineData("title-only", true, false)]
    [InlineData("busy", false, false)]
    public void IcsAndPrivacy(string mode, bool title, bool location)
    {
        var events = new[] { new StoredEvent("stable@bridge", "Review, plan; path\\a\nNext", "Room",
            DateTimeOffset.Parse("2026-09-29T10:00:00+01:00"), DateTimeOffset.Parse("2026-09-29T11:00:00+01:00"),
            false, null, null, Day) };
        var ics = IcsWriter.Write(events, app.Options with { PrivacyMode = mode, CalendarName = "ukhsa" });
        Assert.StartsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n", ics);
        Assert.EndsWith("END:VEVENT\r\nEND:VCALENDAR\r\n", ics);
        Assert.Contains("UID:stable@bridge\r\n", ics);
        Assert.Contains("DTSTART:20260929T090000Z", ics);
        Assert.Contains("DTEND:20260929T100000Z", ics);
        Assert.Equal(title, ics.Contains(@"SUMMARY:UKHSA: Review\, plan\; path\\a\nNext"));
        Assert.Equal(location, ics.Contains("LOCATION:Room"));
        if (!title) Assert.Contains("SUMMARY:UKHSA: Busy", ics);
        Assert.DoesNotContain(TestApp.ApiKey, ics);
    }
    [Fact] public void Utf8FoldingAndAllDayDates()
    {
        var longLine = "SUMMARY:" + string.Concat(Enumerable.Repeat("😊 café", 30));
        var folded = IcsWriter.Fold(longLine);
        Assert.All(folded.Split("\r\n"), line => Assert.True(Encoding.UTF8.GetByteCount(line) <= 75));
        Assert.Equal(longLine, folded.Replace("\r\n ", ""));
        var ics = IcsWriter.Write([new("id", "Holiday", "", Day, Day.AddDays(1), true, "20260929", "20260930", Day)], app.Options);
        Assert.Contains("DTSTART;VALUE=DATE:20260929\r\nDTEND;VALUE=DATE:20260930", ics);
    }
    [Fact] public void StrictValidation()
    {
        var now = DateTimeOffset.UtcNow;
        var baseline = Snapshot(Event("Valid"));
        Assert.Single(SnapshotValidator.Validate(baseline, now).Events);
        var invalid = new[] {
            baseline with { Version = 2 }, baseline with { Source = "another-calendar" },
            baseline with { WindowEnd = baseline.WindowStart }, baseline with { WindowEnd = baseline.WindowStart.AddDays(367) },
            baseline with { CapturedAt = now.AddDays(-2) }, baseline with { Events = Enumerable.Repeat(Event("X"), 2001).ToList() },
            baseline with { Events = [Event(new string('X', 501))] }, baseline with { Events = [Event("X") with { Location = new string('X', 501) }] },
            baseline with { Events = [Event("X") with { End = Event("X").Start }] },
            baseline with { Events = [Event("X") with { Start = baseline.WindowEnd, End = baseline.WindowEnd.AddHours(1) }] },
            baseline with { Events = [Event("https://teams.example/join")] },
            baseline with { Events = [Event("X") with { Location = "person@example.com" }] },
            baseline with { Timezone = "Not/AZone" }, baseline with { Events = [Event("X"), Event("X")] },
            baseline with { Events = [Event("X") with { AllDay = true }] }
        };
        Assert.All(invalid, p => Assert.Throws<ArgumentException>(() => SnapshotValidator.Validate(p, now)));
    }
    [Theory]
    [InlineData("2026-09-29T10:00:00")]
    [InlineData("2026-02-30T10:00:00Z")]
    [InlineData("not-a-date")]
    public void TimestampRequiresValidOffset(string timestamp)
    {
        var json = JsonSerializer.Serialize(timestamp);
        Assert.Throws<JsonException>(() => JsonSerializer.Deserialize<DateTimeOffset>(json, WireJson.Options));
    }

    private sealed class NonSeekableStream(byte[] content) : MemoryStream(content)
    {
        public override bool CanSeek => false;
    }
}

public sealed class RateLimitTests
{
    [Fact] public async Task IngestionIsRateLimited()
    {
        using var app = new TestApp();
        using var client = app.Client();
        client.DefaultRequestHeaders.Add("X-API-Key", TestApp.ApiKey);
        for (var i = 0; i < 30; i++)
            Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/calendar/sync", new { })).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await client.PostAsJsonAsync("/api/v1/calendar/sync", new { })).StatusCode);
    }
}
