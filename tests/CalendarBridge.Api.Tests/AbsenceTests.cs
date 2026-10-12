using System.Net;
using System.Net.Http.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class AbsenceTests
{
    private static readonly TimeZoneInfo London = TimeZoneInfo.FindSystemTimeZoneById("Europe/London");
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-10-12T10:00:00+01:00");
    private static StoredEvent Event(string title, bool allDay = true, DateTimeOffset? start = null, DateTimeOffset? end = null) =>
        new(Guid.NewGuid().ToString(), title, "", start ?? Now.Date, end ?? Now.Date.AddDays(1), allDay, null, null, Now);
    private static CalendarReadData Data(params StoredEvent[] events) =>
        new([new("ukhsa", events.Length, Now, Now, Now.Date, Now.Date.AddDays(8))], events.Select(e => new NamedStoredEvent("ukhsa", e)).ToList());

    [Theory]
    [InlineData("Ann-Marie Annual Leave - France", "Ann-Marie", false)]
    [InlineData("Tom S OOO - 2 Days", "Tom S", false)]
    [InlineData("Eugenia OOO", "Eugenia", false)]
    [InlineData("Amy out-of-office", "Amy", false)]
    [InlineData("Amy O.O.O.", "Amy", false)]
    [InlineData("Annual leave - Ann-Marie", "Ann-Marie", false)]
    [InlineData("Nick Meadham - Annual Leave", "Nick Meadham", false)]
    [InlineData("Tom's annual leave", "Tom", false)]
    [InlineData("Eugenia Training", "Eugenia", false)]
    [InlineData("OOO - Tom S - 2 Days", "Tom S", false)]
    [InlineData("Amy is out of the office", "Amy", false)]
    [InlineData("Amy on annual leave", "Amy", false)]
    [InlineData("Amy non-working day", "Amy", false)]
    [InlineData("Amy PTO", "Amy", false)]
    [InlineData("Amy AL", "Amy", false)]
    [InlineData("Amy Anual Leave", "Amy", true)]
    [InlineData("Amy annual leav", "Amy", true)]
    [InlineData("Amy on vacation", "Amy", false)]
    [InlineData("Amy off sick", "Amy", false)]
    [InlineData("Amy parental leave", "Amy", false)]
    public void UsesNamedAbsenceEvidenceAndLimitedTypos(string title, string name, bool fuzzy)
    {
        var result = AbsenceClassifier.Match(Event(title));
        Assert.NotNull(result); Assert.Equal(name, result.Name); Assert.Equal(fuzzy, result.Fuzzy);
    }

    [Theory]
    [InlineData("SRS One-Team Away Day")]
    [InlineData("Annual leave planning")]
    [InlineData("Annual leave policy review")]
    [InlineData("Annual leave approval")]
    [InlineData("Tom OOO handover meeting")]
    [InlineData("Cancelled: Amy OOO")]
    [InlineData("Amy not OOO")]
    [InlineData("Amy back from annual leave")]
    [InlineData("Training workshop")]
    [InlineData("Office planning")]
    [InlineData("Amy WFH")]
    [InlineData("Holiday planning")]
    public void KeepsMeetingsAndWorkingFromHome(string title) => Assert.Null(AbsenceClassifier.Match(Event(title)));

    [Fact] public void ShortAbsenceRequiresStrongWording()
    {
        Assert.NotNull(AbsenceClassifier.Match(Event("Eugenia OOO", false, Now, Now.AddHours(3))));
        Assert.Null(AbsenceClassifier.Match(Event("Eugenia Training", false, Now, Now.AddHours(1))));
        Assert.Null(AbsenceClassifier.Match(Event("Eugenia anual leave", false, Now, Now.AddHours(1))));
    }

    [Fact] public void TodayTomorrowAndPartialDayAreDistinctAndCancelledEventsAreAbsent()
    {
        var report = AbsenceQuery.Build(Data(
            Event("Ann-Marie Annual Leave - France", end: Now.Date.AddDays(1)),
            Event("Eugenia OOO", false, Now.AddHours(-1), Now.AddHours(2)),
            Event("Tom S OOO", start: Now.Date.AddDays(1), end: Now.Date.AddDays(2)),
            Event("Cancelled: Amy OOO")), Now, London);
        Assert.Equal(3, report.People.Count);
        var ann = report.People.Single(p => p.Name == "Ann-Marie");
        Assert.True(ann.OutNow); Assert.True(ann.OutToday); Assert.False(ann.OutTomorrow); Assert.Equal(1, ann.ReturningInDays);
        var eugenia = report.People.Single(p => p.Name == "Eugenia");
        Assert.Equal(0, eugenia.ReturningInDays); Assert.Equal(Now.AddHours(2), eugenia.ExpectedReturn);
        var tom = report.People.Single(p => p.Name == "Tom S");
        Assert.False(tom.OutNow); Assert.False(tom.OutToday); Assert.True(tom.OutTomorrow); Assert.Equal(2, tom.ReturningInDays);
        var later = AbsenceQuery.Build(Data(Event("Eugenia OOO", false, Now.AddHours(-1), Now.AddHours(2))), Now.AddHours(3), London);
        Assert.Empty(later.People);
    }

    [Fact] public void MergesConsecutiveAbsencesButNotSimilarNamesOrCalendars()
    {
        var data = Data(Event("Tom S OOO"), Event("TOM S Annual Leave", start: Now.Date.AddDays(1), end: Now.Date.AddDays(3)),
            Event("Tim S OOO"), Event("Tom S OOO", start: Now.Date.AddDays(5), end: Now.Date.AddDays(6)));
        data.Events.Add(new("ons", Event("Tom S OOO")));
        var report = AbsenceQuery.Build(data, Now, London);
        Assert.Equal(3, report.People.Count);
        Assert.Equal(3, report.People.Single(p => p.CalendarName == "ukhsa" && p.Name == "Tom S").ReturningInDays);
        Assert.Equal(2, AbsenceQuery.Build(data, Now, London, "ukhsa").People.Count);
    }

    [Fact] public void NeverInventsReturnAtCaptureBoundaryOrBeyondSevenDays()
    {
        var data = Data(Event("Amy OOO", end: Now.Date.AddDays(3)));
        data.Calendars[0] = data.Calendars[0] with { WindowEnd = Now.Date.AddDays(3) };
        var person = Assert.Single(AbsenceQuery.Build(data, Now, London).People);
        Assert.Null(person.ExpectedReturn); Assert.Equal("insufficient-coverage", person.ReturnStatus);
        var longLeave = Assert.Single(AbsenceQuery.Build(Data(Event("Amy OOO", end: Now.Date.AddDays(12))), Now, London).People);
        Assert.Null(longLeave.ReturningInDays); Assert.Equal("beyond-seven-days", longLeave.ReturnStatus);
    }

    [Fact] public void AllDayExclusiveDatesAndDstUseLocalCalendarDays()
    {
        var now = DateTimeOffset.Parse("2026-10-24T12:00:00+01:00");
        var e = Event("Amy OOO") with { StartDate = "20261024", EndDate = "20261026" };
        var data = new CalendarReadData([new("ukhsa", 1, now, now, now.AddDays(-1), now.AddDays(7))], [new("ukhsa", e)]);
        var person = Assert.Single(AbsenceQuery.Build(data, now, London).People);
        Assert.True(person.OutTomorrow); Assert.Equal(2, person.ReturningInDays);
        Assert.Equal(DateTimeOffset.Parse("2026-10-26T00:00:00Z"), person.ExpectedReturn);
    }

    [Fact] public void PersonNameBoundariesAreNotLost()
    {
        var report = AbsenceQuery.Build(Data(Event("Tom S OOO"), Event("Toms OOO")), Now, London);
        Assert.Equal(2, report.People.Count);
    }

    [Fact] public void UnnamedAbsenceIsCountedWithoutInventingAPerson()
    {
        var report = AbsenceQuery.Build(Data(Event("OOO")), Now, London);
        Assert.Empty(report.People); Assert.Equal(1, report.UnnamedAbsenceCount);
    }

    [Fact] public async Task ExistingCapturesAreSeparatedAndEndpointsAreAuthenticated()
    {
        const string key = "test-widget-key-012345678901234567890123456789";
        using var app = new TestApp { WidgetKey = key }; using var client = app.Client();
        var store = new CalendarStore(app.Options);
        var now = DateTimeOffset.UtcNow;
        var day = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero);
        CalendarEvent E(string title) => new(null, title, day, day.AddDays(1), "", true);
        CalendarSnapshot S(string name, params CalendarEvent[] events) => new(1, SnapshotValidator.Source, now, day, day.AddDays(8), "UTC", events.ToList(), name);
        store.Replace(S("ukhsa", E("Ann-Marie Annual Leave - France"), E("Tom S OOO - 2 Days"), E("Eugenia OOO"), E("Team planning")));
        store.Replace(S("ons", E("ONS briefing")));
        var feed = await client.GetStringAsync("/calendar/" + TestApp.Token + ".ics?calendar=ukhsa");
        Assert.Contains("Team planning", feed); Assert.DoesNotContain("Ann-Marie", feed); Assert.DoesNotContain("OOO", feed);
        Assert.Equal(4, store.Read("ukhsa").Count);
        Assert.Equal(HttpStatusCode.Unauthorized, (await client.GetAsync("/api/v1/calendar/absences")).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/dakboard/absences/wrong/data")).StatusCode);
        client.DefaultRequestHeaders.Add("X-Calendar-Token", TestApp.Token);
        var report = (await client.GetFromJsonAsync<AbsenceReport>("/api/v1/calendar/absences?calendar=ukhsa&timezone=UTC"))!;
        Assert.Equal(3, report.People.Count); Assert.All(report.People, p => Assert.Equal(1, p.ReturningInDays));
        var clashes = (await client.GetFromJsonAsync<ClashReport>("/api/v1/calendar/clashes"))!;
        Assert.Single(clashes.Clashes);
        client.DefaultRequestHeaders.Clear();
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/dakboard/absences/wrong")).StatusCode);
        var page = await client.GetAsync("/dakboard/absences/" + key);
        Assert.Equal(HttpStatusCode.OK, page.StatusCode);
        Assert.True(page.Headers.CacheControl!.NoStore);
        Assert.False(page.Headers.Contains("X-Frame-Options"));
        Assert.Contains("script-src 'self'", string.Join(" ", page.Headers.GetValues("Content-Security-Policy")));
        var html = await page.Content.ReadAsStringAsync();
        Assert.Contains("/dakboard-assets/absences.js", html);
        Assert.DoesNotContain(TestApp.ApiKey, html); Assert.DoesNotContain(TestApp.Token, html);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/dakboard-assets/absences.js")).StatusCode);
        var widget = await client.GetAsync("/dakboard/absences/" + key + "/data?calendar=ukhsa&timezone=UTC");
        Assert.Equal(HttpStatusCode.OK, widget.StatusCode); Assert.True(widget.Headers.CacheControl!.NoStore);
        Assert.Equal(3, (await widget.Content.ReadFromJsonAsync<AbsenceReport>())!.People.Count);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/dakboard/absences/" + key + "/data?timezone=invalid")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/dakboard/absences/" + key + "/data?calendar=ukhsa&calendar=ons")).StatusCode);
    }
}
