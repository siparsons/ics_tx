using System.Net.Http.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class CancellationTests
{
    [Theory]
    [InlineData("Cancelled: Weekly review", true)]
    [InlineData("CANCELED: Weekly review", true)]
    [InlineData("Weekly review (cancelled)", true)]
    [InlineData("Weekly CANCELLED review", true)]
    [InlineData("Re: canceled - review", true)]
    [InlineData("Uncancelled review", false)]
    [InlineData("Cancellation planning", false)]
    [InlineData("Review cancellation policy", false)]
    [InlineData("Weekly review", false)]
    public void RecognisesCancellationWordsWithoutMatchingOtherWords(string title, bool expected) =>
        Assert.Equal(expected, EventCancellation.IsCancelled(title));

    [Fact] public void DetectorExcludesCancelledTitlesBeforePrivacyRedaction()
    {
        var day = DateTimeOffset.UtcNow.Date.AddDays(1);
        var cancelled = new NamedStoredEvent("ukhsa", new("1", "CANCELLED: Review", "", day.AddHours(10), day.AddHours(11), false, null, null, day));
        var active = new NamedStoredEvent("ons", cancelled.Event with { Id = "2", Title = "Active review" });
        var options = new BridgeOptions("unused", "unused", "Work", "unused", "unused", "primary", [], 262144, 90, "busy", false);
        Assert.Empty(ClashDetector.Find([cancelled, active], options, day, day.AddDays(1)));
    }

    [Fact] public async Task ExistingCancelledCapturesDisappearFromFeedsCountsApiAndWidget()
    {
        const string key = "test-widget-key-012345678901234567890123456789";
        using var app = new TestApp { WidgetKey = key }; using var client = app.Client();
        var store = new CalendarStore(app.Options);
        var day = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(1), TimeSpan.Zero);
        CalendarEvent Event(string title, int hour) => new(null, title, day.AddHours(hour), day.AddHours(hour + 1), "", false);
        CalendarSnapshot Snapshot(string name, params CalendarEvent[] events) => new(1, SnapshotValidator.Source, DateTimeOffset.UtcNow, day, day.AddDays(1), "UTC", events.ToList(), name);
        // Store the raw captures: filtering must also work for data already in SQLite.
        store.Replace(Snapshot("ukhsa", Event("CANCELLED: Old briefing", 10), Event("Review (canceled)", 11), Event("Active briefing", 12)));
        store.Replace(Snapshot("ons", Event("ONS at ten", 10), Event("ONS at eleven", 11), Event("ONS at twelve", 12)));
        Assert.Single(store.Read("ukhsa"));
        var feed = await client.GetStringAsync("/calendar/" + TestApp.Token + ".ics?calendar=ukhsa");
        Assert.Contains("UKHSA: Active briefing", feed);
        Assert.DoesNotContain("Old briefing", feed); Assert.DoesNotContain("canceled", feed);
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        var api = (await client.GetFromJsonAsync<ClashReport>("/api/v1/calendar/clashes"))!;
        Assert.Single(api.Clashes); Assert.Equal("Active briefing", api.Clashes[0].Second.Title);
        Assert.Equal(1, api.Calendars.Single(c => c.Name == "ukhsa").EventCount);
        var widget = (await client.GetFromJsonAsync<WidgetReport>("/dakboard/clashes/" + key + "/data"))!;
        Assert.Single(widget.Clashes); Assert.Equal("UKHSA: Active briefing", widget.Clashes[0].Second.DisplayTitle);
    }
}
