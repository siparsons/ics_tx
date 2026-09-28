using System.Threading.RateLimiting;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Crypto;
using CalendarBridge.Api.Endpoints;
using CalendarBridge.Api.Persistence;
using Microsoft.AspNetCore.Cors.Infrastructure;
using Microsoft.AspNetCore.Server.Kestrel.Core;

var builder = WebApplication.CreateBuilder(args);
// Framework request logs include the feed token in URL paths; never enable HTTP/body logging.
builder.Logging.AddFilter("Microsoft.AspNetCore", LogLevel.None);
builder.Services.AddSingleton(sp => BridgeOptions.Load(sp.GetRequiredService<IConfiguration>()));
builder.Services.AddSingleton<EnvelopeCrypto>();
builder.Services.AddSingleton<CalendarStore>();
builder.Services.AddHostedService<RetentionWorker>();
builder.Services.AddCors();
builder.Services.AddOptions<CorsOptions>().Configure<BridgeOptions>((cors, settings) =>
    cors.AddDefaultPolicy(policy => policy.WithOrigins(settings.AllowedOrigins)
        .WithMethods("GET", "POST", "OPTIONS").WithHeaders("Content-Type", "X-API-Key")));
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
    if (context.Request.Path == "/api/v1/calendar/sync" && context.Request.Method == "POST")
    {
        var keys = context.Request.Headers["X-API-Key"];
        if (keys.Count != 1 || !EnvelopeCrypto.Matches(keys[0], options.ApiKey))
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
app.Run();
public partial class Program;
