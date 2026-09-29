using System.Threading.RateLimiting;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Crypto;
using CalendarBridge.Api.Endpoints;
using CalendarBridge.Api.Persistence;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);
// Framework request logs include feed/widget keys in URL paths; never enable HTTP/body logging.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.None);
builder.Services.AddSingleton(sp => BridgeOptions.Load(sp.GetRequiredService<IConfiguration>()));
builder.Services.AddSingleton<EnvelopeCrypto>();
builder.Services.AddSingleton<CalendarStore>();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton<IClashQuery, ClashQuery>();
builder.Services.AddSingleton(sp => DakboardWidgetOptions.Load(sp.GetRequiredService<IConfiguration>(), sp.GetRequiredService<BridgeOptions>()));
builder.Services.AddHostedService<RetentionWorker>();
builder.Services.AddCors();
builder.Services.AddOptions<CorsOptions>().Configure<BridgeOptions>((cors, settings) =>
    cors.AddDefaultPolicy(policy => policy.WithOrigins(settings.AllowedOrigins)
        .WithMethods("GET", "POST", "OPTIONS").WithHeaders("Content-Type", "X-API-Key", "X-Calendar-Token")));
builder.Services.AddRateLimiter(limiter =>
{
    limiter.RejectionStatusCode = 429;
    limiter.AddPolicy("ingest", _ => RateLimitPartition.GetFixedWindowLimiter("calendar-ingest",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 30, Window = TimeSpan.FromMinutes(1), QueueLimit = 0 }));
});
builder.Services.AddOptions<KestrelServerOptions>().Configure<BridgeOptions>(
    (server, settings) => server.Limits.MaxRequestBodySize = settings.MaxPayloadBytes);
if (int.TryParse(builder.Configuration["PORT"], out var port))
    builder.WebHost.UseUrls($"http://0.0.0.0:{port}");
var app = builder.Build();
var options = app.Services.GetRequiredService<BridgeOptions>();
app.Services.GetRequiredService<EnvelopeCrypto>();
var widgetOptions = app.Services.GetRequiredService<DakboardWidgetOptions>();
if (widgetOptions.Misconfigured) app.Logger.LogWarning("DAKboard widget disabled: configure a valid independent DAKBOARD_WIDGET_KEY.");
var store = app.Services.GetRequiredService<CalendarStore>();
store.Initialize();
store.Cleanup(DateTimeOffset.UtcNow);
app.Use(async (context, next) =>
{
    context.Response.Headers.XContentTypeOptions = "nosniff";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    // Trust Render's TLS termination header only inside Render's private backend.
    var secure = context.Request.IsHttps ||
        (options.OnRender && context.Request.Headers["X-Forwarded-Proto"] == "https");
    if (context.Request.Path != "/health" && !secure) { context.Response.StatusCode = 400; return; }
    if (secure) context.Response.Headers.StrictTransportSecurity = "max-age=31536000";
    try { await next(); }
    catch (OperationCanceledException) when (context.RequestAborted.IsCancellationRequested) { }
    catch (Exception)
    {
        app.Logger.LogError("Calendar request failed.");
        if (!context.Response.HasStarted)
        {
            context.Response.Clear();
            context.Response.Headers["Referrer-Policy"] = "no-referrer";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            context.Response.Headers.CacheControl = "no-store";
            context.Response.StatusCode = 500;
            await context.Response.WriteAsJsonAsync(new { error = "Request could not be completed." });
        }
    }
});
app.UseRouting();
app.UseCors();
app.Use(async (context, next) =>
{
    var endpoint = context.GetEndpoint();
    if (endpoint?.Metadata.GetMetadata<DakboardWidgetAccess>() is not null)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers["Referrer-Policy"] = "no-referrer";
        context.Response.Headers["Content-Security-Policy"] = DakboardEndpoints.ContentPolicy;
        context.Response.Headers["X-Robots-Tag"] = "noindex, nofollow, noarchive";
        if (!widgetOptions.Allows(context.Request.RouteValues["widgetKey"]?.ToString()))
        {
            context.Response.StatusCode = 404;
            return;
        }
    }
    var readCalendar = endpoint?.Metadata.GetMetadata<CalendarReadAccess>() is not null;
    if (readCalendar || endpoint?.Metadata.GetMetadata<CalendarWriteAccess>() is not null)
    {
        context.Response.Headers.CacheControl = "no-store";
        var keys = context.Request.Headers["X-API-Key"];
        var tokens = context.Request.Headers["X-Calendar-Token"];
        var authorized = keys.Count == 1 && EnvelopeCrypto.Matches(keys[0], options.ApiKey);
        if (readCalendar) authorized |= tokens.Count == 1 && EnvelopeCrypto.Matches(tokens[0], options.FeedToken);
        if (!authorized)
        {
            context.Response.Headers.CacheControl = "no-store";
            context.Response.StatusCode = 401;
            return;
        }
    }
    await next();
});
app.UseRateLimiter();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "public, max-age=60"
});
app.MapBridge();
app.MapClashes();
app.MapDakboard();
app.Run();
public partial class Program;
