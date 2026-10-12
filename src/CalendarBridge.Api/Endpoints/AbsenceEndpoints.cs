using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;

namespace CalendarBridge.Api.Endpoints;

public static class AbsenceEndpoints
{
    private static readonly Lazy<string> Page = new(() =>
    {
        using var stream = typeof(AbsenceEndpoints).Assembly.GetManifestResourceStream("CalendarBridge.Api.Dakboard.absences.html")
            ?? throw new InvalidOperationException("Absence widget page is missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });

    public static void MapAbsences(this WebApplication app)
    {
        app.MapGet("/dakboard/absences/{widgetKey}", () => Results.Content(Page.Value, "text/html; charset=utf-8"))
            .WithMetadata(new DakboardWidgetAccess());
        app.MapGet("/api/v1/calendar/absences", Report).WithMetadata(new CalendarReadAccess());
        app.MapGet("/dakboard/absences/{widgetKey}/data", Report).WithMetadata(new DakboardWidgetAccess());
    }
    private static IResult Report(HttpContext context, AbsenceQuery service, BridgeOptions options)
    {
        context.Response.Headers.CacheControl = "no-store";
        var query = context.Request.Query;
        if (query.Any(q => q.Key is not ("calendar" or "timezone") || q.Value.Count != 1))
            return Results.BadRequest(new { error = "Use calendar and timezone only, without duplicates." });
        var calendar = query.ContainsKey("calendar") ? query["calendar"].ToString() : null;
        if (calendar is not null && !SnapshotValidator.ValidName(calendar))
            return Results.BadRequest(new { error = "Invalid calendar name." });
        if (options.PrivacyMode == "busy")
            return Results.Json(new { error = "Absence names are unavailable in busy privacy mode." }, statusCode: 403);
        try { return Results.Json(service.GetReport(calendar, query.ContainsKey("timezone") ? query["timezone"].ToString() : "Europe/London")); }
        catch (Exception e) when (e is TimeZoneNotFoundException or InvalidTimeZoneException)
        { return Results.BadRequest(new { error = "Unknown timezone." }); }
        catch (ClashLimitException)
        { return Results.Json(new { error = "Too many events; no partial absence report was returned." }, statusCode: 422); }
    }
}
