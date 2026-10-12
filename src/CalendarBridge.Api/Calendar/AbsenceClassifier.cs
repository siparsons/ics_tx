using System.Text.RegularExpressions;
using CalendarBridge.Api.Models;

namespace CalendarBridge.Api.Calendar;

public sealed record AbsenceMatch(string? Name, string Evidence, bool Fuzzy);

public static class AbsenceClassifier
{
    private static readonly Regex Words = new(@"[\p{L}]+(?:['\u2019-][\p{L}]+)*", RegexOptions.CultureInvariant);
    private static readonly string[] Strong = ["out of the office", "out of office", "ooo", "oof", "day off", "non working day", "annual leave", "on leave", "on holiday", "on vacation", "sick leave", "sickness absence", "maternity leave", "paternity leave", "parental leave", "compassionate leave", "bereavement leave", "unpaid leave", "study leave", "pto"];
    private static readonly string[] Contextual = ["holiday", "vacation", "leave", "absent", "off sick", "training", "al"];
    // A subject discussing absence is still a meeting, not an absence notification.
    private static readonly HashSet<string> MeetingWords = new(["meeting", "review", "planning", "plan", "policy", "request", "requests", "approval", "approvals", "handover", "cover", "coverage", "rota", "team", "workshop", "standup", "stand", "catch", "discussion", "discuss", "return", "back", "cancelled", "canceled", "not", "no", "office", "day", "days", "management"], StringComparer.OrdinalIgnoreCase);

    public static AbsenceMatch? Match(StoredEvent e)
    {
        if (EventCancellation.IsCancelled(e.Title)) return null;
        var title = Regex.Replace(e.Title, @"\bO\s*\.\s*O\s*\.\s*O\.?", "OOO", RegexOptions.IgnoreCase);
        title = Regex.Replace(title, @"\bout[-\s]+of[-\s]+office\b", "out of office", RegexOptions.IgnoreCase);
        title = Regex.Replace(title, @"\bnon-working\b", "non working", RegexOptions.IgnoreCase);
        var tokens = Words.Matches(title).Cast<Match>().ToArray();
        var lower = tokens.Select(t => t.Value.ToLowerInvariant()).ToArray();
        var substantial = e.AllDay || e.End - e.Start >= TimeSpan.FromHours(4);
        if (lower.Any(w => w is "meeting" or "review" or "planning" or "policy" or "request" or "requests"
            or "approval" or "approvals" or "handover" or "cover" or "coverage" or "workshop" or "discussion"
            or "not" or "back" or "return")) return null;
        // Prefer a complete strong phrase (including a small typo) over a weaker word inside it.
        foreach (var phrase in Strong.Concat(Contextual))
        foreach (var fuzzy in new[] { false, true })
        {
            var parts = phrase.Split(' ');
            var contextual = Contextual.Contains(phrase);
            if ((contextual || fuzzy) && !substantial) continue;
            if (fuzzy && parts.Any(p => p.Length < 4)) continue;
            for (var i = 0; i <= tokens.Length - parts.Length; i++)
            {
                var differences = 0;
                for (var j = 0; j < parts.Length; j++)
                {
                    if (lower[i + j] == parts[j]) continue;
                    differences += fuzzy && EditDistanceAtMostOne(lower[i + j], parts[j]) ? 1 : 100;
                }
                if (differences > (fuzzy ? 1 : 0) || fuzzy && differences == 0) continue;
                var left = title[..tokens[i].Index].Trim(' ', '-', ':', '\u2013', '\u2014');
                var end = tokens[i + parts.Length - 1].Index + tokens[i + parts.Length - 1].Length;
                var right = title[end..].Trim(' ', '-', ':', '\u2013', '\u2014');
                // Prefix names are unambiguous: trailing text is a destination or duration.
                var name = PersonName(left.Length > 0 ? left : Regex.Split(right, @"\s[-–—]\s")[0]);
                if (name is not null) return new(name, phrase, fuzzy);
                if (!contextual && !fuzzy && left.Length == 0 && right.Length == 0)
                    return new(null, phrase, false);
            }
        }
        return null;
    }

    private static string? PersonName(string text)
    {
        text = Regex.Replace(text, @"['\u2019]s$", "", RegexOptions.IgnoreCase).Trim();
        text = Regex.Replace(text, @"\s+(?:is|on)$", "", RegexOptions.IgnoreCase);
        var words = Words.Matches(text).Cast<Match>().Select(m => m.Value).ToArray();
        if (words.Length is < 1 or > 4 || words.Any(MeetingWords.Contains)) return null;
        if (Regex.Replace(text, @"[\p{L}\s.'\u2019-]", "").Length > 0) return null;
        return string.Join(" ", words);
    }

    internal static bool EditDistanceAtMostOne(string a, string b)
    {
        if (Math.Abs(a.Length - b.Length) > 1) return false;
        var i = 0; var j = 0; var changes = 0;
        while (i < a.Length && j < b.Length)
        {
            if (a[i] == b[j]) { i++; j++; continue; }
            if (++changes > 1) return false;
            if (a.Length >= b.Length) i++;
            if (b.Length >= a.Length) j++;
        }
        return changes + (a.Length - i) + (b.Length - j) <= 1;
    }
}
