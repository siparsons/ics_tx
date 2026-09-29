using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class ClashTests
{
    private static readonly DateTimeOffset Day = new(2026, 9, 29, 0, 0, 0, TimeSpan.Zero);
    private static BridgeOptions Options => new("unused", "unused", "Work Calendar", "unused", "unused", "primary", [], 262144, 90, "full", false);
    private static NamedStoredEvent Entry(string calendar, string id, double start, double end, bool allDay = false) =>
        new(calendar, new(id, "Private meeting", "Private room", Day.AddHours(start), Day.AddHours(end), allDay,
            allDay ? "20260929" : null, allDay ? "20260930" : null, Day));

    [Fact] public void CrossCalendarOverlapIsReportedOnceAndTouchingEventsDoNotClash()
    {
        var events = new[] { Entry("ukhsa", "a", 10, 11), Entry("ons", "b", 10.5, 11.5), Entry("third", "c", 11.5, 12), Entry("ukhsa", "d", 10, 10.25) };
        var clash = Assert.Single(ClashDetector.Find(events, Options, Day, Day.AddDays(1)));
        Assert.Equal(Day.AddHours(10.5), clash.OverlapStart);
        Assert.Equal(Day.AddHours(11), clash.OverlapEnd);
        Assert.Equal(30, clash.OverlapMinutes);
        Assert.Equal("ons", clash.First.CalendarName);
        Assert.Equal("ONS: Private meeting", clash.First.DisplayTitle);
        Assert.Equal("ukhsa", clash.Second.CalendarName);
    }
    [Fact] public void NestedAndThreeWayOverlapsProduceDistinctStablePairs()
    {
        var events = new[] { Entry("a", "1", 10, 14), Entry("b", "2", 11, 13), Entry("c", "3", 11.5, 12) };
        var clashes = ClashDetector.Find(events, Options, Day, Day.AddDays(1));
        Assert.Equal(3, clashes.Count);
        Assert.Equal(3, clashes.Select(c => c.Id).Distinct().Count());
        Assert.Equal(clashes.Select(c => c.Id), ClashDetector.Find(events.Reverse(), Options, Day, Day.AddDays(1)).Select(c => c.Id));
        var clipped = ClashDetector.Find(events.Take(2), Options, Day.AddHours(11.5), Day.AddHours(12));
        Assert.Equal(clashes.Single(c => c.First.CalendarName == "a" && c.Second.CalendarName == "b").Id, Assert.Single(clipped).Id);
        Assert.Equal(30, clipped[0].OverlapMinutes);
    }
    [Fact] public void AllDayAndWithinCalendarCanBeIncludedOrExcluded()
    {
        var events = new[] { Entry("a", "all", 0, 24, true), Entry("b", "timed", 10, 11), Entry("b", "same", 10.5, 12) };
        Assert.Equal(2, ClashDetector.Find(events, Options, Day, Day.AddDays(1)).Count);
        Assert.Empty(ClashDetector.Find(events, Options, Day, Day.AddDays(1), includeAllDay: false));
        Assert.Single(ClashDetector.Find(events, Options, Day, Day.AddDays(1), includeAllDay: false, includeWithinCalendar: true));
        Assert.Equal(3, ClashDetector.Find(events, Options, Day, Day.AddDays(1), includeWithinCalendar: true).Count);
    }
    [Fact] public void OvernightAndOffsetEquivalentEventsAreComparedAsInstants()
    {
        var first = Entry("a", "overnight", -1, 2);
        var second = Entry("b", "offset", 0, 1);
        second = second with { Event = second.Event with { Start = second.Event.Start.ToOffset(TimeSpan.FromHours(1)), End = second.Event.End.ToOffset(TimeSpan.FromHours(1)) } };
        Assert.Equal(60, Assert.Single(ClashDetector.Find([first, second], Options, Day, Day.AddDays(1))).OverlapMinutes);
        Assert.Empty(ClashDetector.Find([first, second], Options, Day.AddHours(2), Day.AddDays(1)));
    }
    [Theory]
    [InlineData("full", "Private meeting", "Private room")]
    [InlineData("title-only", "Private meeting", null)]
    [InlineData("busy", "Busy", null)]
    public void ReadApiHonoursPrivacyMode(string mode, string title, string? location)
    {
        var clash = Assert.Single(ClashDetector.Find([Entry("a", "1", 10, 11), Entry("b", "2", 10, 11)], Options with { PrivacyMode = mode }, Day, Day.AddDays(1)));
        Assert.Equal(title, clash.First.Title);
        Assert.Equal("A: " + title, clash.First.DisplayTitle);
        Assert.Equal(location, clash.First.Location);
    }
    [Fact] public void ExcessiveResultsFailInsteadOfSilentlyTruncating()
    {
        Assert.Throws<ClashLimitException>(() => ClashDetector.Find(Enumerable.Range(0, 10001).Select(i => Entry("a", i.ToString(), 10, 11)), Options, Day, Day.AddDays(1)));
        Assert.Throws<ClashLimitException>(() => ClashDetector.Find(Enumerable.Range(0, 143).Select(i => Entry(i.ToString(), i.ToString(), 10, 11)), Options, Day, Day.AddDays(1)));
    }
    private static CalendarSnapshot Snapshot(string name, DateTimeOffset day, params CalendarEvent[] events) =>
        new(1, SnapshotValidator.Source, DateTimeOffset.UtcNow, day, day.AddDays(1), "UTC", events.ToList(), name);
    private static string Range(DateTimeOffset day) => "?from=" + Uri.EscapeDataString(day.ToString("O")) + "&to=" + Uri.EscapeDataString(day.AddDays(1).ToString("O"));

    [Fact] public async Task ApiListsEmptyCalendarsAndUpdatesClashesAfterSnapshotReplacement()
    {
        using var app = new TestApp(); using var client = app.Client();
        var store = new CalendarStore(app.Options); var day = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(1), TimeSpan.Zero);
        store.Replace(Snapshot("ukhsa", day, new CalendarEvent(null, "First", day.AddHours(10), day.AddHours(11), "Room", false)));
        var ons = Snapshot("ons", day, new CalendarEvent(null, "Second", day.AddHours(10.5), day.AddHours(12), "", false));
        store.Replace(ons); store.Replace(Snapshot("empty", day));
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        var list = await client.GetFromJsonAsync<JsonElement>("/api/v1/calendars");
        Assert.Equal(new[] { "empty", "ons", "ukhsa" }, list.GetProperty("calendars").EnumerateArray().Select(x => x.GetProperty("name").GetString()));
        Assert.Equal(0, list.GetProperty("calendars")[0].GetProperty("eventCount").GetInt32());
        Assert.Equal(day, list.GetProperty("calendars")[0].GetProperty("windowStart").GetDateTimeOffset());
        var response = await client.GetAsync("/api/v1/calendar/clashes" + Range(day));
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl!.NoStore);
        var report = (await response.Content.ReadFromJsonAsync<ClashReport>())!;
        Assert.Equal(1, report.ClashCount); Assert.Single(report.Clashes);
        Assert.Equal(3, report.Calendars.Count);
        Assert.Equal("ONS: Second", report.Clashes[0].First.DisplayTitle);
        store.Replace(ons with { CapturedAt = ons.CapturedAt.AddSeconds(1), Events = [] });
        var updated = (await client.GetFromJsonAsync<ClashReport>("/api/v1/calendar/clashes" + Range(day)))!;
        Assert.Equal(0, updated.ClashCount); Assert.Empty(updated.Clashes);
        Assert.Equal(0, updated.Calendars.Single(c => c.Name == "ons").EventCount);
        Assert.Equal(ons.CapturedAt.AddSeconds(1).ToUnixTimeMilliseconds(), updated.Calendars.Single(c => c.Name == "ons").LastCapturedAt!.Value.ToUnixTimeMilliseconds());
        var defaults = (await client.GetFromJsonAsync<ClashReport>("/api/v1/calendar/clashes"))!;
        Assert.Equal(TimeSpan.FromDays(7), defaults.To - defaults.From);
        Assert.True(defaults.IncludeAllDay); Assert.False(defaults.IncludeWithinCalendar);
    }
    [Fact] public async Task BothReadEndpointsRequireCredentialsAndFeedTokenCannotWrite()
    {
        using var app = new TestApp(); using var client = app.Client();
        foreach (var path in new[] { "/api/v1/calendars", "/api/v1/calendar/clashes", "/api/v1/calendars/", "/api/v1/calendar/clashes/", "/API/v1/CALENDARS" })
        {
            var unauthenticated = await client.GetAsync(path);
            Assert.Equal(HttpStatusCode.Unauthorized, unauthenticated.StatusCode);
            Assert.True(unauthenticated.Headers.CacheControl!.NoStore);
            using var wrong = new HttpRequestMessage(HttpMethod.Get, path);
            wrong.Headers.Add("X-Calendar-Token", "wrong");
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(wrong)).StatusCode);
            using var keyed = new HttpRequestMessage(HttpMethod.Get, path);
            keyed.Headers.Add("X-API-Key", TestApp.ApiKey);
            Assert.Equal(HttpStatusCode.OK, (await client.SendAsync(keyed)).StatusCode);
            using var duplicate = new HttpRequestMessage(HttpMethod.Get, path);
            duplicate.Headers.Add("X-Calendar-Token", new[] { TestApp.Token, TestApp.Token });
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.SendAsync(duplicate)).StatusCode);
        }
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        foreach (var path in new[] { "/api/v1/calendar/sync", "/api/v1/calendar/sync/", "/API/v1/CALENDAR/SYNC" })
            Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsJsonAsync(path, new {})).StatusCode);
    }
    [Fact] public async Task InvalidQueriesReturn400AndExplicitOffsetsAndFlagsWork()
    {
        using var app = new TestApp(); using var client = app.Client();
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        foreach (var query in new[] { "?from=2026-09-29T00:00:00Z", "?from=2026-09-29&to=2026-09-30", "?includeAllDay=maybe",
            "?includeWithinCalendar=1", "?includeAllDay=true&includeAllDay=false", "?form=typo",
            "?from=2026-09-30T00:00:00Z&to=2026-09-29T00:00:00Z", "?from=2025-01-01T00:00:00Z&to=2027-01-01T00:00:00Z",
            "?from=2026-09-29T00:00:00&to=2026-09-30T00:00:00", "?from=2026-02-30T00:00:00Z&to=2026-03-01T00:00:00Z" })
            Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/api/v1/calendar/clashes" + query)).StatusCode);
        var report = (await client.GetFromJsonAsync<ClashReport>("/api/v1/calendar/clashes?from=2026-09-29T00:00:00%2B01:00&to=2026-09-30T00:00:00%2B01:00&includeAllDay=false&includeWithinCalendar=true"))!;
        Assert.Equal(new DateTimeOffset(2026,9,28,23,0,0,TimeSpan.Zero), report.From);
        Assert.False(report.IncludeAllDay); Assert.True(report.IncludeWithinCalendar);
    }
    [Fact] public async Task ReadTokenCorsPreflightUsesOnlyConfiguredOrigins()
    {
        using var app = new TestApp(); using var client = app.Client();
        foreach (var origin in new[] { "https://outlook.office.com", "https://unconfigured.example" })
        {
            using var request = new HttpRequestMessage(HttpMethod.Options, "/api/v1/calendar/clashes");
            request.Headers.Add("Origin", origin);
            request.Headers.Add("Access-Control-Request-Method", "GET");
            request.Headers.Add("Access-Control-Request-Headers", "X-Calendar-Token");
            var result = await client.SendAsync(request);
            Assert.Equal(origin == "https://outlook.office.com", result.Headers.Contains("Access-Control-Allow-Origin"));
        }
    }
}
