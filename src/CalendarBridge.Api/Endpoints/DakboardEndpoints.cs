using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Models;
using Microsoft.Data.Sqlite;

namespace CalendarBridge.Api.Endpoints;

public sealed class DakboardWidgetAccess;
public static class DakboardEndpoints
{
    // No frame-ancestors or X-Frame-Options restriction: the secret URL is intended for an iframe.
    // This policy is applied only to the new widget routes.
    public const string ContentPolicy = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'";
    private static readonly Lazy<string> Page = new(() =>
    {
        using var stream = typeof(DakboardEndpoints).Assembly.GetManifestResourceStream("CalendarBridge.Api.Dakboard.clashes.html")
            ?? throw new InvalidOperationException("Widget page is missing.");
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    });
    public static void MapDakboard(this WebApplication app)
    {
        app.MapGet("/dakboard/clashes/{widgetKey}", () => Results.Content(Page.Value, "text/html; charset=utf-8"))
            .WithMetadata(new DakboardWidgetAccess());
        app.MapGet("/dakboard/clashes/{widgetKey}/data", (IClashQuery query, ILoggerFactory logs) =>
        {
            try { return Results.Json(WidgetReport.From(query.GetReport(includeAllDay: false, includeWithinCalendar: false))); }
            catch (Exception e) when (e is ClashLimitException or SqliteException)
            {
                // Do not log the exception, request path, widget key, or appointment details.
                logs.CreateLogger("DakboardWidget").LogWarning("Calendar clash data unavailable.");
                return Results.Json(new { error = "Calendar clash data unavailable" }, statusCode: 503);
            }
        }).WithMetadata(new DakboardWidgetAccess());
    }
}
