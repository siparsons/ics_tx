using System.Globalization;
using CalendarBridge.Api.Calendar;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;
using Microsoft.Data.Sqlite;

namespace CalendarBridge.Api.Persistence;

public sealed class StaleSnapshotException : Exception;
public sealed class CalendarStore(BridgeOptions options)
{
    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = Path.GetFullPath(options.DbPath),
            Mode = SqliteOpenMode.ReadWriteCreate, DefaultTimeout = 10, Pooling = true
        }.ToString());
        connection.Open();
        connection.CreateFunction<string, bool>("is_cancelled", EventCancellation.IsCancelled, isDeterministic: true);
        return connection;
    }
    public void Initialize()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(options.DbPath))!);
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = """
            PRAGMA journal_mode=WAL;
            CREATE TABLE IF NOT EXISTS Snapshots (
              Id TEXT PRIMARY KEY, CalendarName TEXT NOT NULL DEFAULT 'default', Source TEXT NOT NULL, CapturedUtc INTEGER NOT NULL,
              WindowStartUtc INTEGER NOT NULL, WindowEndUtc INTEGER NOT NULL, ImportedUtc INTEGER NOT NULL);
            CREATE INDEX IF NOT EXISTS IX_Snapshots_Window ON Snapshots(Source, WindowStartUtc, WindowEndUtc);
            CREATE TABLE IF NOT EXISTS CalendarEvents (
              Id TEXT PRIMARY KEY, CalendarName TEXT NOT NULL DEFAULT 'default', Source TEXT NOT NULL, SourceId TEXT, Title TEXT NOT NULL, Location TEXT NOT NULL,
              StartUtc INTEGER NOT NULL, EndUtc INTEGER NOT NULL, AllDay INTEGER NOT NULL,
              StartDate TEXT, EndDate TEXT, CreatedUtc INTEGER NOT NULL, UpdatedUtc INTEGER NOT NULL,
              SnapshotId TEXT NOT NULL);
            CREATE INDEX IF NOT EXISTS IX_Events_Start ON CalendarEvents(Source, StartUtc);
            """;
        cmd.ExecuteNonQuery();
        foreach (var table in new[] { "Snapshots", "CalendarEvents" })
        {
            cmd.CommandText = $"PRAGMA table_info({table})";
            using var reader = cmd.ExecuteReader();
            var found = false;
            while (reader.Read()) if (reader.GetString(1) == "CalendarName") found = true;
            reader.Close();
            if (!found)
            {
                cmd.CommandText = $"ALTER TABLE {table} ADD COLUMN CalendarName TEXT NOT NULL DEFAULT 'default'";
                cmd.ExecuteNonQuery();
            }
        }
        cmd.CommandText = """
            CREATE INDEX IF NOT EXISTS IX_Snapshots_Calendar ON Snapshots(CalendarName, Source, WindowStartUtc, WindowEndUtc);
            CREATE INDEX IF NOT EXISTS IX_Events_Calendar ON CalendarEvents(CalendarName, Source, StartUtc);
            """;
        cmd.ExecuteNonQuery();
    }

    public string Replace(CalendarSnapshot snapshot)
    {
        using var db = Open();
        // Immediate write lock serializes overlap checks and replacement across requests.
        using var tx = db.BeginTransaction(deferred: false);
        using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            SELECT COUNT(*) FROM Snapshots WHERE CalendarName=$calendar AND Source=$source
              AND WindowStartUtc < $end AND WindowEndUtc > $start AND CapturedUtc >= $captured
            """;
        cmd.Parameters.AddWithValue("$source", snapshot.Source);
        cmd.Parameters.AddWithValue("$calendar", snapshot.CalendarName);
        cmd.Parameters.AddWithValue("$start", snapshot.WindowStart.ToUnixTimeMilliseconds());
        cmd.Parameters.AddWithValue("$end", snapshot.WindowEnd.ToUnixTimeMilliseconds());
        cmd.Parameters.AddWithValue("$captured", snapshot.CapturedAt.ToUnixTimeMilliseconds());
        if (Convert.ToInt64(cmd.ExecuteScalar(), CultureInfo.InvariantCulture) != 0) throw new StaleSnapshotException();
        cmd.CommandText = "DELETE FROM CalendarEvents WHERE CalendarName=$calendar AND Source=$source AND StartUtc >= $start AND StartUtc < $end";
        cmd.ExecuteNonQuery();
        var id = Guid.NewGuid().ToString("N");
        var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        cmd.CommandText = "INSERT INTO Snapshots (Id,CalendarName,Source,CapturedUtc,WindowStartUtc,WindowEndUtc,ImportedUtc) VALUES ($id,$calendar,$source,$captured,$start,$end,$now)";
        cmd.Parameters.AddWithValue("$id", id);
        cmd.Parameters.AddWithValue("$now", now);
        cmd.ExecuteNonQuery();
        var zone = TimeZoneInfo.FindSystemTimeZoneById(snapshot.Timezone);
        foreach (var e in snapshot.Events)
        {
            cmd.Parameters.Clear();
            cmd.CommandText = """
                INSERT INTO CalendarEvents
                (Id,CalendarName,Source,SourceId,Title,Location,StartUtc,EndUtc,AllDay,StartDate,EndDate,CreatedUtc,UpdatedUtc,SnapshotId)
                VALUES ($id,$calendar,$source,$sourceId,$title,$location,$start,$end,$allDay,$startDate,$endDate,$now,$now,$snapshot)
                """;
            cmd.Parameters.AddWithValue("$id", SnapshotValidator.Identity(snapshot.Source + "/" + snapshot.CalendarName, e));
            cmd.Parameters.AddWithValue("$source", snapshot.Source);
            cmd.Parameters.AddWithValue("$calendar", snapshot.CalendarName);
            cmd.Parameters.AddWithValue("$sourceId", (object?)e.SourceId ?? DBNull.Value);
            cmd.Parameters.AddWithValue("$title", e.Title);
            cmd.Parameters.AddWithValue("$location", e.Location ?? "");
            cmd.Parameters.AddWithValue("$start", e.Start.ToUnixTimeMilliseconds());
            cmd.Parameters.AddWithValue("$end", e.End.ToUnixTimeMilliseconds());
            cmd.Parameters.AddWithValue("$allDay", e.AllDay ? 1 : 0);
            cmd.Parameters.AddWithValue("$startDate", e.AllDay ? TimeZoneInfo.ConvertTime(e.Start, zone).ToString("yyyyMMdd", CultureInfo.InvariantCulture) : DBNull.Value);
            cmd.Parameters.AddWithValue("$endDate", e.AllDay ? TimeZoneInfo.ConvertTime(e.End, zone).ToString("yyyyMMdd", CultureInfo.InvariantCulture) : DBNull.Value);
            cmd.Parameters.AddWithValue("$now", now);
            cmd.Parameters.AddWithValue("$snapshot", id);
            cmd.ExecuteNonQuery();
        }
        tx.Commit();
        return id;
    }

    public List<StoredEvent> Read(string calendarName = "default")
    {
        using var db = Open();
        using var cmd = db.CreateCommand();
        cmd.CommandText = "SELECT Id,Title,Location,StartUtc,EndUtc,AllDay,StartDate,EndDate,UpdatedUtc FROM CalendarEvents WHERE CalendarName=$calendar AND is_cancelled(Title)=0 ORDER BY StartUtc,Id";
        cmd.Parameters.AddWithValue("$calendar", calendarName);
        using var reader = cmd.ExecuteReader();
        var result = new List<StoredEvent>();
        while (reader.Read())
            result.Add(new(reader.GetString(0), reader.GetString(1), reader.GetString(2),
                DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(3)), DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)),
                reader.GetInt64(5) != 0, reader.IsDBNull(6) ? null : reader.GetString(6),
                reader.IsDBNull(7) ? null : reader.GetString(7), DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(8))));
        return result;
    }

    // Both lists share a read transaction so a concurrent sync cannot mix generations.
    public CalendarReadData ReadCalendars(DateTimeOffset? from = null, DateTimeOffset? to = null, bool includeAllDay = true)
    {
        using var db = Open();
        using var tx = db.BeginTransaction(deferred: true);
        using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            WITH Names AS (
              SELECT CalendarName FROM Snapshots UNION SELECT CalendarName FROM CalendarEvents
            ), Latest AS (
              SELECT *, ROW_NUMBER() OVER (PARTITION BY CalendarName ORDER BY CapturedUtc DESC, ImportedUtc DESC, Id) AS Rank
              FROM Snapshots
            ), Counts AS (
              SELECT CalendarName, COUNT(*) AS EventCount FROM CalendarEvents WHERE is_cancelled(Title)=0 GROUP BY CalendarName
            )
            SELECT n.CalendarName, COALESCE(c.EventCount,0), s.CapturedUtc, s.ImportedUtc, s.WindowStartUtc, s.WindowEndUtc
            FROM Names n LEFT JOIN Latest s ON s.CalendarName=n.CalendarName AND s.Rank=1
            LEFT JOIN Counts c ON c.CalendarName=n.CalendarName ORDER BY n.CalendarName
            """;
        var calendars = new List<TrackedCalendar>();
        using (var reader = cmd.ExecuteReader())
        {
            DateTimeOffset? Time(int i) => reader.IsDBNull(i) ? null : DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(i));
            while (reader.Read()) calendars.Add(new(reader.GetString(0), reader.GetInt32(1), Time(2), Time(3), Time(4), Time(5)));
        }
        var events = new List<NamedStoredEvent>();
        if (from.HasValue && to.HasValue)
        {
            cmd.CommandText = """
                SELECT CalendarName,Id,Title,Location,StartUtc,EndUtc,AllDay,StartDate,EndDate,UpdatedUtc
                FROM CalendarEvents WHERE StartUtc < $to AND EndUtc > $from AND ($allDay=1 OR AllDay=0) AND is_cancelled(Title)=0
                ORDER BY StartUtc,CalendarName,Id LIMIT 10001
                """;
            cmd.Parameters.AddWithValue("$from", from.Value.ToUnixTimeMilliseconds());
            cmd.Parameters.AddWithValue("$to", to.Value.ToUnixTimeMilliseconds());
            cmd.Parameters.AddWithValue("$allDay", includeAllDay ? 1 : 0);
            using var reader = cmd.ExecuteReader();
            while (reader.Read()) events.Add(new(reader.GetString(0), new(reader.GetString(1), reader.GetString(2), reader.GetString(3),
                DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(4)), DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(5)),
                reader.GetInt64(6) != 0, reader.IsDBNull(7) ? null : reader.GetString(7), reader.IsDBNull(8) ? null : reader.GetString(8),
                DateTimeOffset.FromUnixTimeMilliseconds(reader.GetInt64(9)))));
        }
        tx.Commit();
        return new(calendars, events);
    }

    public void Cleanup(DateTimeOffset now)
    {
        using var db = Open();
        using var tx = db.BeginTransaction();
        using var cmd = db.CreateCommand();
        cmd.Transaction = tx;
        cmd.CommandText = """
            DELETE FROM CalendarEvents WHERE EndUtc < $cutoff;
            DELETE FROM Snapshots WHERE ImportedUtc < $cutoff
              AND Id NOT IN (SELECT SnapshotId FROM CalendarEvents);
            """;
        cmd.Parameters.AddWithValue("$cutoff", now.AddDays(-options.RetentionDays).ToUnixTimeMilliseconds());
        cmd.ExecuteNonQuery();
        tx.Commit();
    }
}

public sealed class RetentionWorker(CalendarStore store, ILogger<RetentionWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromHours(6));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken))
            {
                try { store.Cleanup(DateTimeOffset.UtcNow); }
                catch (SqliteException) { logger.LogWarning("Calendar retention cleanup failed; will retry at next interval."); }
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
    }
}
