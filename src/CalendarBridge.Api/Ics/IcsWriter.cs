using System.Globalization;
using System.Text;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;

namespace CalendarBridge.Api.Ics;

public static class IcsWriter
{
    public static string Write(IEnumerable<StoredEvent> events, BridgeOptions options)
    {
        var output = new StringBuilder();
        void Line(string line) => output.Append(Fold(line)).Append("\r\n");
        Line("BEGIN:VCALENDAR");
        Line("VERSION:2.0");
        Line("PRODID:-//CalendarBridge//Outlook Web Calendar//EN");
        Line("CALSCALE:GREGORIAN");
        Line("METHOD:PUBLISH");
        Line("X-WR-CALNAME:" + Escape(options.CalendarName));
        foreach (var e in events)
        {
            Line("BEGIN:VEVENT");
            Line("UID:" + e.Id);
            Line("DTSTAMP:" + Timestamp(e.Updated));
            if (e.AllDay)
            {
                Line("DTSTART;VALUE=DATE:" + e.StartDate);
                Line("DTEND;VALUE=DATE:" + e.EndDate);
            }
            else
            {
                Line("DTSTART:" + Timestamp(e.Start));
                Line("DTEND:" + Timestamp(e.End));
            }
            Line("SUMMARY:" + Escape(options.PrivacyMode == "busy" ? "Busy" : e.Title));
            if (options.PrivacyMode == "full" && e.Location.Length > 0) Line("LOCATION:" + Escape(e.Location));
            Line("END:VEVENT");
        }
        Line("END:VCALENDAR");
        return output.ToString();
    }

    public static string Timestamp(DateTimeOffset value) => value.UtcDateTime.ToString("yyyyMMdd'T'HHmmss'Z'", CultureInfo.InvariantCulture);
    public static string Escape(string text) => text.Replace("\\", "\\\\").Replace("\r\n", "\n").Replace("\r", "\n")
        .Replace("\n", "\\n").Replace(";", "\\;").Replace(",", "\\,");
    public static string Fold(string text)
    {
        var result = new StringBuilder();
        var octets = 0;
        foreach (var rune in text.EnumerateRunes())
        {
            if (octets + rune.Utf8SequenceLength > 75)
            {
                result.Append("\r\n ");
                octets = 1; // Continuation whitespace counts toward 75 octets.
            }
            result.Append(rune.ToString());
            octets += rune.Utf8SequenceLength;
        }
        return result.ToString();
    }
}
