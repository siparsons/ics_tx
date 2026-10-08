using System.Net;
using System.Net.Http.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class SpanningEventTests
{
    private static DateTimeOffset Day => new(DateTime.UtcNow.Date.AddDays(1), TimeSpan.Zero);
    private static CalendarEvent Event(string title, int startHours, int endHours, bool allDay = false) =>
        new(null, title, Day.AddHours(startHours), Day.AddHours(endHours), "", allDay);
    private static CalendarSnapshot Snapshot(params CalendarEvent[] events) =>
        new(1, SnapshotValidator.Source, DateTimeOffset.UtcNow, Day, Day.AddDays(7), "UTC", events.ToList());

    [Theory]
    [InlineData(-24, 192, true)] // Leave spanning both edges of the week.
    [InlineData(-1, 1, false)] // Overnight meeting from the previous day.
    [InlineData(167, 169, false)] // Meeting continuing after the view.
    public void OverlappingEventsKeepTheirFullDates(int start, int end, bool allDay)
    {
        var original = Event("Spanning appointment", start, end, allDay);
        var snapshot = SnapshotValidator.Validate(Snapshot(original), DateTimeOffset.UtcNow);
        Assert.Equal(original, Assert.Single(snapshot.Events));
        Assert.Equal(Day, snapshot.WindowStart);
        Assert.Equal(Day.AddDays(7), snapshot.WindowEnd);
    }

    [Theory]
    [InlineData(-2, -1)]
    [InlineData(-1, 0)]
    [InlineData(168, 169)]
    public void EventsWhollyOutsideOrTouchingTheBoundaryAreRejected(int start, int end) =>
        Assert.Throws<ArgumentException>(() => SnapshotValidator.Validate(
            Snapshot(Event("Outside", start, end)), DateTimeOffset.UtcNow));

    [Fact]
    public async Task EncryptedSyncHandlesSpanningLeaveUpdatesRemovalAndRollingWindows()
    {
        using var app = new TestApp();
        using var client = app.Client();
        client.DefaultRequestHeaders.Add("X-API-Key", TestApp.ApiKey);
        var store = new CalendarStore(app.Options);
        var captured = DateTimeOffset.UtcNow.AddMinutes(-5);
        async Task Sync(CalendarSnapshot snapshot)
        {
            captured = captured.AddSeconds(1);
            var response = await client.PostAsJsonAsync("/api/v1/calendar/sync",
                app.Encrypt(snapshot with { CapturedAt = captured }));
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        }
        var leave = Event("Annual leave", -24, 192, true);
        var before = Event("Before view", -48, -24);
        var after = Event("After view", 192, 193);
        await Sync(Snapshot(before, leave, after) with { WindowStart = Day.AddDays(-2), WindowEnd = Day.AddDays(9) });
        var uid = store.Read().Single(e => e.Title == "Annual leave").Id;
        // The same event captured again must replace, not duplicate or fail insertion.
        await Sync(Snapshot(leave));
        Assert.Equal(3, store.Read().Count);
        Assert.Equal(uid, store.Read().Single(e => e.Title == "Annual leave").Id);
        var feed = await client.GetStringAsync($"/calendar/{TestApp.Token}.ics");
        Assert.Contains("DTSTART;VALUE=DATE:" + Day.AddDays(-1).ToString("yyyyMMdd"), feed);
        Assert.Contains("DTEND;VALUE=DATE:" + Day.AddDays(8).ToString("yyyyMMdd"), feed);
        // Rename and shorten the carry-in appointment; the old identity must disappear.
        var changed = leave with { Title = "Updated leave", End = Day.AddDays(3) };
        await Sync(Snapshot(changed));
        Assert.DoesNotContain(store.Read(), e => e.Title == "Annual leave");
        Assert.Equal(3, store.Read().Count);
        // Advance the view one day while the leave is still ongoing.
        await Sync(Snapshot(changed) with { WindowStart = Day.AddDays(1), WindowEnd = Day.AddDays(8) });
        Assert.Equal(3, store.Read().Count);
        // A removal in that window also removes the carry-in event, preserving both neighbours.
        await Sync(Snapshot() with { WindowStart = Day.AddDays(1), WindowEnd = Day.AddDays(8) });
        Assert.Equal(new[] { "Before view", "After view" }, store.Read().Select(e => e.Title));
    }
}
