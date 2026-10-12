using System.Globalization;
using System.Text.RegularExpressions;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;

namespace CalendarBridge.Api.Calendar;

public sealed class AbsenceQuery(CalendarStore store, TimeProvider clock)
{
    public AbsenceReport GetReport(string? calendar = null, string timezone = "Europe/London")
    {
        var zone = TimeZoneInfo.FindSystemTimeZoneById(timezone);
        var now = clock.GetUtcNow();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);
        var start = Midnight(today, zone);
        var data = store.ReadCalendars(start.AddDays(-1), Midnight(today.AddDays(10), zone));
        return Build(data, now, zone, calendar);
    }

    public static AbsenceReport Build(CalendarReadData data, DateTimeOffset now, TimeZoneInfo zone, string? calendar = null)
    {
        if (data.Events.Count > 10000) throw new ClashLimitException();
        var today = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(now, zone).DateTime);
        var tomorrow = Midnight(today.AddDays(1), zone);
        var afterTomorrow = Midnight(today.AddDays(2), zone);
        var calendars = data.Calendars.Where(c => calendar is null || c.Name == calendar).ToList();
        var matches = data.Events.Where(e => calendar is null || e.CalendarName == calendar)
            .Select(e => (Entry: e, Match: AbsenceClassifier.Match(e.Event)))
            .Where(e => e.Match is not null).ToList();
        var people = new List<AbsentPerson>();
        var unnamed = matches.Count(m => m.Match!.Name is null && m.Entry.Event.End > now && m.Entry.Event.Start < afterTomorrow);
        // Name spelling is not sufficient proof that two different colleagues are the same person.
        // Normalize punctuation/case only; fuzzy matching is restricted to absence wording.
        foreach (var group in matches.Where(m => m.Match!.Name is not null)
                     .GroupBy(m => (m.Entry.CalendarName, Name: Normalize(m.Match!.Name!))))
        {
            var periods = group.Select(m => Period(m.Entry.Event, m.Match!, zone)).OrderBy(p => p.Start).ToList();
            var relevant = periods.Where(p => p.End > now && p.Start < afterTomorrow).ToList();
            if (relevant.Count == 0) continue;
            var first = relevant[0];
            var end = first.End;
            foreach (var p in periods.Where(p => p.Start >= first.Start))
            {
                if (p.Start > end) break;
                if (p.End > end) end = p.End;
            }
            var capture = calendars.SingleOrDefault(c => c.Name == group.Key.CalendarName);
            var returnDate = DateOnly.FromDateTime(TimeZoneInfo.ConvertTime(end, zone).DateTime);
            var days = returnDate.DayNumber - today.DayNumber;
            var withinWeek = days is >= 0 and <= 7;
            // Do not call a capture boundary a return: the next unseen day may also contain leave.
            var covered = capture?.WindowStart <= first.Start && capture?.WindowEnd > end;
            // A spanning event may start before the visible window; coverage of now through its end is sufficient.
            covered |= capture?.WindowStart <= now && capture?.WindowEnd > end;
            DateTimeOffset? expected = withinWeek && covered ? end : null;
            people.Add(new(group.Key.CalendarName, group.First().Match!.Name!,
                relevant.Any(p => p.Start <= now && p.End > now),
                relevant.Any(p => p.Start < tomorrow && p.End > now),
                relevant.Any(p => p.Start < afterTomorrow && p.End > tomorrow),
                expected, expected.HasValue ? days : null,
                !withinWeek ? "beyond-seven-days" : !covered ? "insufficient-coverage" : "expected",
                relevant));
        }
        return new(now, zone.Id, today, today.AddDays(1), people.OrderBy(p => !p.OutToday).ThenBy(p => p.CalendarName)
            .ThenBy(p => p.Name, StringComparer.OrdinalIgnoreCase).ToList(), unnamed, calendars);
    }

    private static AbsencePeriod Period(StoredEvent e, AbsenceMatch match, TimeZoneInfo zone)
    {
        // All-day dates are floating calendar dates, not UTC dates (especially across DST).
        var start = e.Start; var end = e.End;
        if (e.AllDay && DateOnly.TryParseExact(e.StartDate, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var from)
            && DateOnly.TryParseExact(e.EndDate, "yyyyMMdd", CultureInfo.InvariantCulture, DateTimeStyles.None, out var to))
        { start = Midnight(from, zone); end = Midnight(to, zone); }
        return new(start, end, e.AllDay, match.Evidence, match.Fuzzy);
    }
    private static string Normalize(string name) => Regex.Replace(Regex.Replace(name.ToLowerInvariant(), @"[.’']", ""), @"[\s-]+", " ").Trim();
    private static DateTimeOffset Midnight(DateOnly day, TimeZoneInfo zone) =>
        new(day.ToDateTime(TimeOnly.MinValue), zone.GetUtcOffset(day.ToDateTime(TimeOnly.MinValue)));
}
