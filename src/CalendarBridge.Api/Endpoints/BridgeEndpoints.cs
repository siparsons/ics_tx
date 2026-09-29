using System.Buffers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Crypto;
using CalendarBridge.Api.Ics;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Microsoft.Data.Sqlite;

namespace CalendarBridge.Api.Endpoints;

public static class BridgeEndpoints
{
    public static void MapBridge(this WebApplication app)
    {
        app.MapGet("/health", () => Results.Json(new { status = "ok" }));
        app.MapGet("/api/v1/crypto/public-key", (HttpContext context, EnvelopeCrypto crypto) =>
        {
            context.Response.Headers.CacheControl = "public, max-age=300";
            return Results.Json(crypto.PublicKey());
        });
        app.MapPost("/api/v1/calendar/sync", Sync).WithMetadata(new CalendarWriteAccess()).RequireRateLimiting("ingest");
        app.MapGet("/calendar/{feedToken}.ics", (string feedToken, HttpContext context, BridgeOptions options, CalendarStore store) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            if (!EnvelopeCrypto.Matches(feedToken, options.FeedToken)) return Results.NotFound();
            var name = QueryName(context.Request);
            if (name is null) return Results.BadRequest(new { error = "Invalid calendar name." });
            context.Response.Headers.CacheControl = "private, max-age=60, must-revalidate";
            return Results.Text(IcsWriter.Write(store.Read(name), options with { CalendarName = name == "default" ? options.CalendarName : name }), "text/calendar; charset=utf-8", Encoding.UTF8);
        });
    }

    private static string? QueryName(HttpRequest request)
    {
        var values = request.Query["calendar"];
        var name = values.Count == 0 ? "default" : values[0];
        return values.Count <= 1 && SnapshotValidator.ValidName(name) ? name : null;
    }

    private static async Task<IResult> Sync(HttpContext context, BridgeOptions options, EnvelopeCrypto crypto, CalendarStore store,
        ILoggerFactory loggerFactory)
    {
        context.Response.Headers.CacheControl = "no-store";
        if (!context.Request.HasJsonContentType()) return Results.StatusCode(415);
        if (context.Request.ContentLength > options.MaxPayloadBytes) return Results.StatusCode(413);
        var buffer = ArrayPool<byte>.Shared.Rent(options.MaxPayloadBytes + 1);
        try
        {
            var size = 0;
            while (size <= options.MaxPayloadBytes)
            {
                var n = await context.Request.Body.ReadAsync(buffer.AsMemory(size, options.MaxPayloadBytes + 1 - size), context.RequestAborted);
                if (n == 0) break;
                size += n;
            }
            if (size > options.MaxPayloadBytes) return Results.StatusCode(413);
            var envelope = JsonSerializer.Deserialize<EncryptedEnvelope>(buffer.AsSpan(0, size), WireJson.Options) ?? throw new JsonException();
            var snapshot = SnapshotValidator.Validate(crypto.Decrypt(envelope), DateTimeOffset.UtcNow);
            var name = QueryName(context.Request);
            if (name is null || snapshot.CalendarName != name)
                return Results.Json(new { error = "Calendar name must match the encrypted snapshot." }, statusCode: 400);
            var id = store.Replace(snapshot);
            loggerFactory.CreateLogger("CalendarSync").LogInformation("Snapshot imported; event count: {Count}", snapshot.Events.Count);
            return Results.Json(new { snapshotId = id, eventCount = snapshot.Events.Count });
        }
        catch (Exception e) when (e is JsonException or CryptographicException or FormatException or ArgumentException)
        {
            return Results.Json(new { error = "Invalid encrypted snapshot." }, statusCode: 400);
        }
        catch (StaleSnapshotException)
        {
            return Results.Json(new { error = "A newer or identical capture already covers this window. Capture again." }, statusCode: 409);
        }
        catch (SqliteException)
        {
            return Results.Json(new { error = "Calendar storage is temporarily unavailable." }, statusCode: 503);
        }
        catch (BadHttpRequestException e) when (e.StatusCode == 413) { return Results.StatusCode(413); }
        finally { ArrayPool<byte>.Shared.Return(buffer, clearArray: true); }
    }
}
