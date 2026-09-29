namespace CalendarBridge.Api.Models;

public sealed record TrackedCalendar(string Name, int EventCount, DateTimeOffset? LastCapturedAt,
    DateTimeOffset? LastImportedAt, DateTimeOffset? WindowStart, DateTimeOffset? WindowEnd);
public sealed record NamedStoredEvent(string CalendarName, StoredEvent Event);
public sealed record CalendarReadData(List<TrackedCalendar> Calendars, List<NamedStoredEvent> Events);
public sealed record ClashEvent(string Id, string CalendarName, string Title, string DisplayTitle,
    DateTimeOffset Start, DateTimeOffset End, bool AllDay, string? StartDate, string? EndDate, string? Location);
public sealed record CalendarClash(string Id, DateTimeOffset OverlapStart, DateTimeOffset OverlapEnd,
    double OverlapMinutes, ClashEvent First, ClashEvent Second);
public sealed record ClashReport(DateTimeOffset GeneratedAt, DateTimeOffset From, DateTimeOffset To,
    bool IncludeAllDay, bool IncludeWithinCalendar, int ClashCount,
    List<TrackedCalendar> Calendars, List<CalendarClash> Clashes);
