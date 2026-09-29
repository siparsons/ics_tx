using System.Security.Cryptography;
using System.Text;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;

namespace CalendarBridge.Api.Calendar;

public sealed class ClashLimitException : Exception;
public static class ClashDetector
{
    public static List<CalendarClash> Find(IEnumerable<NamedStoredEvent> source, BridgeOptions options,
        DateTimeOffset from, DateTimeOffset to, bool includeAllDay = true, bool includeWithinCalendar = false)
    {
        var events = source.Where(e => e.Event.Start < to && e.Event.End > from && (includeAllDay || !e.Event.AllDay))
            .OrderBy(e => e.Event.Start).ThenBy(e => e.CalendarName, StringComparer.Ordinal).ThenBy(e => e.Event.Id, StringComparer.Ordinal).ToList();
        if (events.Count > 10000) throw new ClashLimitException();
        var active = new List<NamedStoredEvent>();
        var result = new List<CalendarClash>();
        foreach (var current in events)
        {
            active.RemoveAll(e => e.Event.End <= current.Event.Start);
            foreach (var previous in active)
            {
                if (!includeWithinCalendar && previous.CalendarName == current.CalendarName) continue;
                var start = new[] { previous.Event.Start, current.Event.Start, from }.Max();
                var end = new[] { previous.Event.End, current.Event.End, to }.Min();
                if (start >= end) continue;
                if (result.Count == 10000) throw new ClashLimitException();
                var pair = new[] { previous, current }.OrderBy(e => e.CalendarName, StringComparer.Ordinal)
                    .ThenBy(e => e.Event.Id, StringComparer.Ordinal).ToArray();
                var identity = System.Text.Json.JsonSerializer.Serialize(pair.Select(e => new[] { e.CalendarName, e.Event.Id }));
                var id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity))).ToLowerInvariant();
                result.Add(new(id, start, end, (end - start).TotalMinutes, Display(pair[0], options), Display(pair[1], options)));
            }
            active.Add(current);
        }
        return result.OrderBy(c => c.OverlapStart).ThenBy(c => c.Id, StringComparer.Ordinal).ToList();
    }
    private static ClashEvent Display(NamedStoredEvent entry, BridgeOptions options)
    {
        var e = entry.Event;
        var title = options.PrivacyMode == "busy" ? "Busy" : e.Title;
        var name = entry.CalendarName == "default" ? options.CalendarName : entry.CalendarName;
        return new(e.Id, entry.CalendarName, title, name.ToUpperInvariant() + ": " + title,
            e.Start, e.End, e.AllDay, e.StartDate, e.EndDate, options.PrivacyMode == "full" ? e.Location : null);
    }
}
