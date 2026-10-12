namespace CalendarBridge.Api.Models;

public sealed record AbsencePeriod(DateTimeOffset Start, DateTimeOffset End, bool AllDay, string Evidence, bool Fuzzy);
public sealed record AbsentPerson(string CalendarName, string Name, bool OutNow, bool OutToday, bool OutTomorrow,
    DateTimeOffset? ExpectedReturn, int? ReturningInDays, string ReturnStatus, List<AbsencePeriod> Periods);
public sealed record AbsenceReport(DateTimeOffset GeneratedAt, string Timezone, DateOnly Today, DateOnly Tomorrow,
    List<AbsentPerson> People, int UnnamedAbsenceCount, List<TrackedCalendar> Calendars);
