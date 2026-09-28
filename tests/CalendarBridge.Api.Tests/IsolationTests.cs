using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Models;
using CalendarBridge.Api.Persistence;
using Xunit;

namespace CalendarBridge.Api.Tests;

public sealed class IsolationTests
{
    private static CalendarSnapshot Snapshot(string calendarName, string title, DateTimeOffset captured)
    {
        var day = new DateTimeOffset(DateTime.UtcNow.Date.AddDays(1), TimeSpan.Zero);
        return new(1, SnapshotValidator.Source, captured, day, day.AddDays(1), "UTC",
            [new(null, title, day.AddHours(10), day.AddHours(11), "Room", false)], calendarName);
    }

    [Fact] public void NamedSnapshotsAndUidsAreIsolated()
    {
        using var app = new TestApp();
        var store = new CalendarStore(app.Options); store.Initialize();
        var now = DateTimeOffset.UtcNow;
        var a = Snapshot("work-laptop", "Same meeting", now);
        var b = Snapshot("meeting-room", "Same meeting", now);
        store.Replace(a); store.Replace(b);
        Assert.NotEqual(Assert.Single(store.Read("work-laptop")).Id, Assert.Single(store.Read("meeting-room")).Id);
        Assert.Empty(store.Read());
        store.Replace(a with { CapturedAt = now.AddSeconds(1), Events = [] });
        Assert.Empty(store.Read("work-laptop"));
        Assert.Single(store.Read("meeting-room"));
    }

    [Fact] public async Task EncryptedNameMustMatchQueryAndFeedSelectsOnlyThatCalendar()
    {
        using var app = new TestApp();
        using var client = app.Client();
        client.DefaultRequestHeaders.Add("X-API-Key", TestApp.ApiKey);
        var snapshot = Snapshot("work-laptop", "Laptop only", DateTimeOffset.UtcNow);
        var envelope = app.Encrypt(snapshot);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.PostAsJsonAsync("/api/v1/calendar/sync?calendar=meeting-room", envelope)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/v1/calendar/sync?calendar=work-laptop", envelope)).StatusCode);
        var a = await client.GetStringAsync("/calendar/" + TestApp.Token + ".ics?calendar=work-laptop");
        var b = await client.GetStringAsync("/calendar/" + TestApp.Token + ".ics?calendar=meeting-room");
        Assert.Contains("SUMMARY:Laptop only", a);
        Assert.Contains("X-WR-CALNAME:work-laptop", a);
        Assert.DoesNotContain("Laptop only", b);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/calendar/" + TestApp.Token + ".ics?calendar=bad%20name")).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await client.GetAsync("/calendar/" + TestApp.Token + ".ics?calendar=a&calendar=b")).StatusCode);
    }

    [Fact] public async Task ActualBrowserCryptoInteroperatesWithDotNetAndSqlite()
    {
        using var app = new TestApp();
        using var client = app.Client();
        var publicKey = JsonDocument.Parse(await client.GetStringAsync("/api/v1/crypto/public-key")).RootElement.Clone();
        var payload = Snapshot("interop", "Browser crypto café", DateTimeOffset.UtcNow);
        var root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../"));
        using var process = new Process { StartInfo = new ProcessStartInfo("node")
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
        } };
        process.StartInfo.ArgumentList.Add(Path.Combine(root, "tests/encrypt-fixture.mjs"));
        process.Start();
        await process.StandardInput.WriteAsync(JsonSerializer.Serialize(new { payload, publicKey }, WireJson.Options));
        process.StandardInput.Close();
        var outputTask = process.StandardOutput.ReadToEndAsync();
        var errorTask = process.StandardError.ReadToEndAsync();
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(30));
        try { await process.WaitForExitAsync(timeout.Token); }
        catch { process.Kill(entireProcessTree: true); throw; }
        Assert.True(process.ExitCode == 0, await errorTask);
        var envelope = JsonSerializer.Deserialize<EncryptedEnvelope>(await outputTask, WireJson.Options)!;
        client.DefaultRequestHeaders.Add("X-API-Key", TestApp.ApiKey);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsJsonAsync("/api/v1/calendar/sync?calendar=interop", envelope)).StatusCode);
        var feed = await client.GetStringAsync("/calendar/" + TestApp.Token + ".ics?calendar=interop");
        Assert.Contains("SUMMARY:Browser crypto café", feed);
    }
}
