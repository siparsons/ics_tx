using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using CalendarBridge.Api.Models;

namespace CalendarBridge.Api.Calendar;

public static class SnapshotValidator
{
    public const string Source = "outlook-web-bookmarklet";
    public static bool ValidName(string? name) => name is not null && Regex.IsMatch(name, "^[a-z0-9][a-z0-9_-]{0,63}$");
    public static CalendarSnapshot Validate(CalendarSnapshot p, DateTimeOffset now)
    {
        if (!ValidName(p.CalendarName) || p.Version != 1 || p.Source != Source || p.Events is null || p.Events.Count > 2000
            || p.WindowEnd <= p.WindowStart || p.WindowEnd - p.WindowStart > TimeSpan.FromDays(366)
            || p.WindowStart < now.AddYears(-5) || p.WindowEnd > now.AddYears(5)
            || p.CapturedAt < now.AddHours(-24) || p.CapturedAt > now.AddMinutes(5))
            throw new ArgumentException("Invalid snapshot metadata.");
        TimeZoneInfo zone;
        try { zone = TimeZoneInfo.FindSystemTimeZoneById(p.Timezone ?? ""); }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException or ArgumentException)
        { throw new ArgumentException("Invalid timezone."); }
        var events = new List<CalendarEvent>();
        var identities = new HashSet<string>();
        foreach (var ev in p.Events)
        {
            if (ev is null || ev.End <= ev.Start || ev.End - ev.Start > TimeSpan.FromDays(366)
                || ev.Start < p.WindowStart || ev.Start >= p.WindowEnd || string.IsNullOrWhiteSpace(ev.Title)
                || ev.Title.Length > 500 || (ev.Location?.Length ?? 0) > 500 || (ev.SourceId?.Length ?? 0) > 256)
                throw new ArgumentException("Invalid event.");
            if (ev.SourceId is not null && !Regex.IsMatch(ev.SourceId, @"^[A-Za-z0-9_\-:.]{1,256}$"))
                throw new ArgumentException("Invalid source identifier.");
            if (ContainsContactData(ev.Title) || ContainsContactData(ev.Location ?? ""))
                throw new ArgumentException("Remove contact addresses and URLs from display fields.");
            if (ev.AllDay && (TimeZoneInfo.ConvertTime(ev.Start, zone).TimeOfDay != TimeSpan.Zero
                || TimeZoneInfo.ConvertTime(ev.End, zone).TimeOfDay != TimeSpan.Zero))
                throw new ArgumentException("All-day events require local midnight boundaries.");
            var clean = ev with { Title = Clean(ev.Title), Location = Clean(ev.Location ?? "") };
            if (string.IsNullOrWhiteSpace(clean.Title) || !identities.Add(Identity(p.Source, clean)))
                throw new ArgumentException("Empty or duplicate event.");
            events.Add(clean);
        }
        return p with { Events = events };
    }
    private static bool ContainsContactData(string s) => Regex.IsMatch(s, @"(?i)https?://|www\.|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}");
    public static string Clean(string s) => new(s.Normalize(NormalizationForm.FormC)
        .Where(c => !char.IsControl(c) || c is '\n' or '\r' or '\t').ToArray());
    public static string Identity(string source, CalendarEvent e) => Convert.ToHexString(SHA256.HashData(
        JsonSerializer.SerializeToUtf8Bytes(new object[] { source, e.Start.ToUnixTimeMilliseconds(),
            e.End.ToUnixTimeMilliseconds(), e.Title, e.Location ?? "", e.AllDay }))).ToLowerInvariant() + "@calendar-bridge";
}
