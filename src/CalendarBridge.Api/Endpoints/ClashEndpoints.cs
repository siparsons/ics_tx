using System.Text.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;

namespace CalendarBridge.Api.Endpoints;

public static class ClashEndpoints
{
    public static void MapClashes(this WebApplication app)
    {
        app.MapGet("/api/v1/calendars", (HttpContext context, CalendarStore store) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Json(new { calendars = store.ReadCalendars().Calendars });
        }).WithMetadata(new CalendarReadAccess());
        app.MapGet("/api/v1/calendar/clashes", (HttpContext context, IClashQuery clashQuery, TimeProvider clock) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var now = clock.GetUtcNow();
            var query = context.Request.Query;
            var allowed = new[] { "from", "to", "includeAllDay", "includeWithinCalendar" };
            if (query.Any(q => !allowed.Contains(q.Key) || q.Value.Count != 1) || query.ContainsKey("from") != query.ContainsKey("to"))
                return Results.BadRequest(new { error = "Use from and to together, with no duplicate or unknown query parameters." });
            var from = now;
            var to = now.AddDays(7);
            if (query.ContainsKey("from") && (!Timestamp(query["from"].ToString(), out from) || !Timestamp(query["to"].ToString(), out to)))
                return Results.BadRequest(new { error = "from and to must be ISO 8601 timestamps with seconds and an explicit UTC offset." });
            if (to <= from || to - from > TimeSpan.FromDays(366))
                return Results.BadRequest(new { error = "Choose a positive time range of at most 366 days." });
            var allDay = true;
            var within = false;
            if ((query.ContainsKey("includeAllDay") && !bool.TryParse(query["includeAllDay"], out allDay)) ||
                (query.ContainsKey("includeWithinCalendar") && !bool.TryParse(query["includeWithinCalendar"], out within)))
                return Results.BadRequest(new { error = "includeAllDay and includeWithinCalendar must be true or false." });
            try
            {
                return Results.Json(clashQuery.GetReport(from, to, allDay, within));
            }
            catch (ClashLimitException)
            {
                return Results.Json(new { error = "The requested range exceeds 10000 events or clashes. Request a smaller range; no partial results are returned." }, statusCode: 422);
            }
        }).WithMetadata(new CalendarReadAccess());
    }
    private static bool Timestamp(string value, out DateTimeOffset result)
    {
        try { result = JsonSerializer.Deserialize<DateTimeOffset>(JsonSerializer.Serialize(value), WireJson.Options); return true; }
        catch (JsonException) { result = default; return false; }
    }
}
