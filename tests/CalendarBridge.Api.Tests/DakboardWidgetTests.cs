using System.Net;
using System.Net.Http.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.DependencyInjection.Extensions;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class DakboardWidgetTests
{
    private const string WidgetKey = "test-widget-key-012345678901234567890123456789";
    private const string Route = "/dakboard/clashes/" + WidgetKey;
    private static HttpClient Client(WebApplicationFactory<Program> app) => app.CreateClient(new() { BaseAddress = new Uri("https://localhost") });
    private static readonly DateTimeOffset Now = new(2026, 9, 29, 8, 0, 0, TimeSpan.Zero);
    private sealed class FixedClock : TimeProvider { public override DateTimeOffset GetUtcNow() => Now; }
    private sealed class FakeQuery : IClashQuery
    {
        public bool? AllDay; public bool? Within; public int Calls;
        public Exception? Failure;
        public ClashReport Report = new(Now, Now, Now.AddDays(7), false, false, 0, [], []);
        public ClashReport GetReport(DateTimeOffset? from = null, DateTimeOffset? to = null, bool includeAllDay = true, bool includeWithinCalendar = false)
        {
            Calls++; AllDay = includeAllDay; Within = includeWithinCalendar;
            if (Failure is not null) throw Failure;
            return Report;
        }
    }
    private static WebApplicationFactory<Program> WithQuery(TestApp app, FakeQuery fake) => app.WithWebHostBuilder(builder =>
        builder.ConfigureTestServices(services => { services.RemoveAll<IClashQuery>(); services.AddSingleton<IClashQuery>(fake); }));

    [Fact] public async Task ValidKeyReturnsEmbeddableHtmlWithoutFeedOrUploadCredentials()
    {
        using var app = new TestApp { WidgetKey = WidgetKey }; using var client = app.Client();
        var response = await client.GetAsync(Route);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType!.MediaType);
        Assert.True(response.Headers.CacheControl!.NoStore);
        Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
        Assert.False(response.Headers.Contains("X-Frame-Options"));
        var policy = Assert.Single(response.Headers.GetValues("Content-Security-Policy"));
        Assert.DoesNotContain("frame-ancestors", policy); Assert.Contains("connect-src 'self'", policy);
        var html = await response.Content.ReadAsStringAsync();
        Assert.Contains("id=\"clash-panel\"", html); Assert.Contains("hidden", html);
        foreach (var secret in new[] { TestApp.ApiKey, TestApp.Token, WidgetKey, "CALENDAR_FEED_TOKEN", "X-API-Key" }) Assert.DoesNotContain(secret, html);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync(Route + "/")).StatusCode);
        // The protected HTML has no public static-file route.
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/Dakboard/clashes.html")).StatusCode);
    }
    [Fact] public async Task InvalidKeysCannotReadPageOrDataEvenWithOtherCredentials()
    {
        using var app = new TestApp { WidgetKey = WidgetKey }; using var client = app.Client();
        client.DefaultRequestHeaders.Add("X-API-Key", TestApp.ApiKey);
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        foreach (var key in new[] { "wrong", TestApp.ApiKey, TestApp.Token, new string('z', 64) })
        foreach (var suffix in new[] { "", "/data", "/data/" })
        {
            var response = await client.GetAsync("/dakboard/clashes/" + key + suffix);
            Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
            Assert.True(response.Headers.CacheControl!.NoStore);
            Assert.Equal("no-referrer", Assert.Single(response.Headers.GetValues("Referrer-Policy")));
        }
    }
    [Theory]
    [InlineData(null)] [InlineData("")] [InlineData("short")]
    [InlineData(TestApp.ApiKey)] [InlineData(TestApp.Token)]
    public async Task MissingOrInvalidConfigurationDisablesWidgetWithoutBreakingService(string? key)
    {
        using var app = new TestApp { WidgetKey = key }; using var client = app.Client();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Route)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync(Route + "/data")).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/health")).StatusCode);
    }
    [Fact] public void InvalidConfigurationAndSeparateKeyAreValidated()
    {
        using var app = new TestApp();
        foreach (var value in new[] { new string('a', 257), new string('a', 40) + "\n", new string('a', 40) + " ", "https://" + new string('a', 40) })
        {
            var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string,string?> { ["DAKBOARD_WIDGET_KEY"] = value }).Build();
            var options = DakboardWidgetOptions.Load(config, app.Options);
            Assert.True(options.Misconfigured); Assert.False(options.Allows(value));
        }
        Assert.True(new DakboardWidgetOptions(WidgetKey).Allows(WidgetKey));
        Assert.False(new DakboardWidgetOptions(WidgetKey).Allows(new string('x', WidgetKey.Length)));
    }
    [Fact] public async Task ZeroClashesUsesExistingQueryWithTimedCrossCalendarDefaults()
    {
        using var app = new TestApp { WidgetKey = WidgetKey }; var fake = new FakeQuery();
        using var factory = WithQuery(app, fake); using var client = Client(factory);
        var response = await client.GetAsync(Route + "/data?includeAllDay=true&includeWithinCalendar=true");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var report = (await response.Content.ReadFromJsonAsync<WidgetReport>())!;
        Assert.Empty(report.Clashes); Assert.Equal(1, fake.Calls);
        Assert.False(fake.AllDay); Assert.False(fake.Within);
        Assert.True(response.Headers.CacheControl!.NoStore);
    }
    [Fact] public async Task ApiAndWidgetResolveTheSameQueryService()
    {
        using var app = new TestApp { WidgetKey = WidgetKey }; var fake = new FakeQuery();
        using var factory = WithQuery(app, fake); using var client = Client(factory);
        await client.GetAsync(Route + "/data"); Assert.Equal(1, fake.Calls);
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        var response = await client.GetAsync("/api/v1/calendar/clashes");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode); Assert.Equal(2, fake.Calls);
    }
    [Fact] public async Task WidgetProjectionIsSortedAndOmitsLocationsAndIndividualIds()
    {
        using var app = new TestApp { WidgetKey = WidgetKey }; var fake = new FakeQuery();
        var first = new ClashEvent("individual-event-id", "ons", "ignored", "ONS: <script>unsafe</script>", Now.AddHours(1), Now.AddHours(3), false, null, null, "secret room");
        var second = first with { Id = "another-event-id", CalendarName = "ukhsa", DisplayTitle = "UKHSA: Review" };
        fake.Report = fake.Report with { ClashCount = 3, Clashes = [
            new("c", Now.AddHours(2), Now.AddHours(3), 60, first, second),
            new("b", Now.AddHours(1), Now.AddHours(2), 60, first, second),
            new("a", Now.AddHours(1), Now.AddHours(2), 60, first, second)] };
        using var factory = WithQuery(app, fake); using var client = Client(factory);
        var text = await client.GetStringAsync(Route + "/data");
        var result = System.Text.Json.JsonSerializer.Deserialize<WidgetReport>(text, new System.Text.Json.JsonSerializerOptions(System.Text.Json.JsonSerializerDefaults.Web))!;
        Assert.Equal(new[] { "a", "b", "c" }, result.Clashes.Select(c => c.Id));
        Assert.Equal(first.DisplayTitle, result.Clashes[0].First.DisplayTitle);
        foreach (var secret in new[] { "secret room", "individual-event-id", "another-event-id", TestApp.Token, TestApp.ApiKey }) Assert.DoesNotContain(secret, text);
    }
    [Fact] public async Task RealQueryUsesNextSevenDaysAndExcludesHistoricAllDayAndWithinCalendarPairs()
    {
        using var app = new TestApp { WidgetKey = WidgetKey };
        using var factory = app.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => {
            services.RemoveAll<TimeProvider>(); services.AddSingleton<TimeProvider>(new FixedClock()); }));
        using var client = Client(factory);
        var store = factory.Services.GetRequiredService<CalendarStore>();
        CalendarEvent Event(string title, int hour, bool allDay = false) => new(null, title, Now.Date.AddHours(hour), Now.Date.AddHours(hour + (allDay ? 24 : 1)), "", allDay);
        CalendarSnapshot Snapshot(string name, params CalendarEvent[] events) => new(1, SnapshotValidator.Source, Now, Now.Date, Now.Date.AddDays(10), "UTC", events.ToList(), name);
        store.Replace(Snapshot("ons", Event("first",10), Event("within",10), Event("old",2), Event("all-day",0,true)));
        store.Replace(Snapshot("ukhsa", Event("second",10), Event("old",2), Event("next-week",24*8+10)));
        var report = (await client.GetFromJsonAsync<WidgetReport>(Route + "/data"))!;
        Assert.Equal(2, report.Clashes.Count);
        Assert.All(report.Clashes, clash => { Assert.True(clash.OverlapStart >= Now); Assert.True(clash.OverlapEnd <= Now.AddDays(7)); Assert.NotEqual(clash.First.CalendarName, clash.Second.CalendarName); });
    }
    [Fact] public async Task SameNamedCalendarConflictsNeverReachWidgetEvenWithQueryOverride()
    {
        using var app = new TestApp { WidgetKey = WidgetKey };
        using var factory = app.WithWebHostBuilder(builder => builder.ConfigureTestServices(services => {
            services.RemoveAll<TimeProvider>(); services.AddSingleton<TimeProvider>(new FixedClock()); }));
        using var client = Client(factory);
        var store = factory.Services.GetRequiredService<CalendarStore>();
        CalendarSnapshot Snapshot(string name, params CalendarEvent[] events) => new(1, SnapshotValidator.Source, Now, Now.Date, Now.Date.AddDays(1), "UTC", events.ToList(), name);
        CalendarEvent Event(string title) => new(null, title, Now.AddHours(1), Now.AddHours(2), "", false);
        store.Replace(Snapshot("ukhsa", Event("Internal meeting one"), Event("Internal meeting two")));
        var internalOnly = (await client.GetFromJsonAsync<WidgetReport>(Route + "/data?includeWithinCalendar=true"))!;
        Assert.Empty(internalOnly.Clashes);
        store.Replace(Snapshot("ons", Event("ONS meeting")));
        var crossCalendar = (await client.GetFromJsonAsync<WidgetReport>(Route + "/data?includeWithinCalendar=true"))!;
        Assert.Equal(2, crossCalendar.Clashes.Count);
        Assert.All(crossCalendar.Clashes, clash => {
            Assert.Equal("ons", clash.First.CalendarName);
            Assert.Equal("ukhsa", clash.Second.CalendarName);
        });
    }
    [Fact] public async Task QueryFailureIsNotAnEmptySuccessfulReport()
    {
        using var app = new TestApp { WidgetKey = WidgetKey }; var fake = new FakeQuery { Failure = new ClashLimitException() };
        using var factory = WithQuery(app, fake); using var client = Client(factory);
        var result = await client.GetAsync(Route + "/data");
        Assert.Equal(HttpStatusCode.ServiceUnavailable, result.StatusCode);
        Assert.Contains("Calendar clash data unavailable", await result.Content.ReadAsStringAsync());
        Assert.True(result.Headers.CacheControl!.NoStore);
        Assert.Equal("no-referrer", Assert.Single(result.Headers.GetValues("Referrer-Policy")));
    }
}
