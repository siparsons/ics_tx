using System.Text.RegularExpressions;

namespace CalendarBridge.Api.Configuration;

public sealed record BridgeOptions(
    string ApiKey, string FeedToken, string CalendarName, string DbPath,
    string PrivateKey, string KeyId, string[] AllowedOrigins, int MaxPayloadBytes,
    int RetentionDays, string PrivacyMode, bool OnRender)
{
    public static BridgeOptions Load(IConfiguration config)
    {
        string Get(string key, string fallback = "") => config["CALENDAR_" + key] ?? fallback;
        int Number(string key, int fallback, int min, int max) =>
            int.TryParse(Get(key, fallback.ToString()), out var n) && n >= min && n <= max
                ? n : throw new InvalidOperationException($"Invalid CALENDAR_{key}.");
        var apiKey = Get("API_KEY");
        var token = Get("FEED_TOKEN");
        if (!Regex.IsMatch(apiKey, "^[A-Za-z0-9_-]{32,256}$") ||
            !Regex.IsMatch(token, "^[A-Za-z0-9_-]{32,256}$") || apiKey == token)
            throw new InvalidOperationException("Configure independent random API and feed credentials (32–256 URL-safe characters).");
        var mode = Get("PRIVACY_MODE", "full");
        if (mode is not ("full" or "title-only" or "busy"))
            throw new InvalidOperationException("Invalid CALENDAR_PRIVACY_MODE.");
        var keyId = Get("RSA_KEY_ID", "primary");
        if (!Regex.IsMatch(keyId, "^[A-Za-z0-9_-]{1,64}$"))
            throw new InvalidOperationException("Invalid CALENDAR_RSA_KEY_ID.");
        var origins = Get("ALLOWED_ORIGINS", "https://outlook.office.com,https://outlook.office365.com,https://outlook.cloud.microsoft")
            .Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (origins.Length == 0 || origins.Any(o => !Uri.TryCreate(o, UriKind.Absolute, out var u)
            || u.Scheme != "https" || u.GetLeftPart(UriPartial.Authority) != o || u.UserInfo.Length != 0))
            throw new InvalidOperationException("Allowed origins must be explicit HTTPS origins without paths.");
        var name = Get("NAME", "Work Calendar");
        if (name.Length is < 1 or > 200 || name.Any(char.IsControl))
            throw new InvalidOperationException("Invalid CALENDAR_NAME.");
        return new(apiKey, token, name, Get("DB_PATH", ".local/calendar.db"),
            Get("RSA_PRIVATE_KEY"), keyId, origins,
            Number("MAX_PAYLOAD_BYTES", 262144, 1024, 4 * 1024 * 1024),
            Number("RETENTION_DAYS", 90, 1, 3650), mode, config["RENDER"] == "true");
    }
}
