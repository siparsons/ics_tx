namespace CalendarBridge.Api.Models;

// Only data needed by the widget is exposed; no locations or individual event IDs.
public sealed record WidgetCalendar(string Name, DateTimeOffset? LastCapturedAt);
public sealed record WidgetAppointment(string CalendarName, string DisplayTitle, DateTimeOffset Start, DateTimeOffset End);
public sealed record WidgetClash(string Id, DateTimeOffset OverlapStart, DateTimeOffset OverlapEnd,
    double OverlapMinutes, WidgetAppointment First, WidgetAppointment Second);
public sealed record WidgetReport(DateTimeOffset GeneratedAt, List<WidgetCalendar> Calendars, List<WidgetClash> Clashes)
{
    public static WidgetReport From(ClashReport report) => new(report.GeneratedAt,
        report.Calendars.Select(c => new WidgetCalendar(c.Name, c.LastCapturedAt)).ToList(),
        report.Clashes.OrderBy(c => c.OverlapStart).ThenBy(c => c.Id, StringComparer.Ordinal).Select(c => new WidgetClash(
            c.Id, c.OverlapStart, c.OverlapEnd, c.OverlapMinutes,
            new(c.First.CalendarName, c.First.DisplayTitle, c.First.Start, c.First.End),
            new(c.Second.CalendarName, c.Second.DisplayTitle, c.Second.Start, c.Second.End))).ToList());
}
