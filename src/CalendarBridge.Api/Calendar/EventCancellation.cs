using System.Text.RegularExpressions;

namespace CalendarBridge.Api.Calendar;

public static partial class EventCancellation
{
    // Outlook exposes cancelled meetings through their displayed subject.
    // Apply on reads as well as clash detection so existing captures update immediately.
    [GeneratedRegex(@"\bcancell?ed\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CancelledTitle();
    public static bool IsCancelled(string title) => CancelledTitle().IsMatch(title);
}
