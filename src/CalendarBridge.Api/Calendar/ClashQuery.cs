using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;

namespace CalendarBridge.Api.Calendar;

public interface IClashQuery
{
    ClashReport GetReport(DateTimeOffset? from = null, DateTimeOffset? to = null,
        bool includeAllDay = true, bool includeWithinCalendar = false);
}

public sealed class ClashQuery(CalendarStore store, BridgeOptions options, TimeProvider clock) : IClashQuery
{
    public ClashReport GetReport(DateTimeOffset? from = null, DateTimeOffset? to = null,
        bool includeAllDay = true, bool includeWithinCalendar = false)
    {
        var now = clock.GetUtcNow();
        var start = from ?? now;
        var end = to ?? start.AddDays(7);
        if (end <= start || end - start > TimeSpan.FromDays(366))
            throw new ArgumentException("Choose a positive time range of at most 366 days.");
        var data = store.ReadCalendars(start, end, includeAllDay);
        var clashes = ClashDetector.Find(data.Events, options, start, end, includeAllDay, includeWithinCalendar);
        return new(now, start.ToUniversalTime(), end.ToUniversalTime(), includeAllDay, includeWithinCalendar,
            clashes.Count, data.Calendars, clashes);
    }
}
