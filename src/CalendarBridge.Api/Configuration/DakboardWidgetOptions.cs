using System.Text.RegularExpressions;
using CalendarBridge.Api.Crypto;

namespace CalendarBridge.Api.Configuration;

public sealed record DakboardWidgetOptions(string? Key, bool Misconfigured = false)
{
    public static DakboardWidgetOptions Load(IConfiguration config, BridgeOptions bridge)
    {
        var key = config["DAKBOARD_WIDGET_KEY"];
        if (string.IsNullOrEmpty(key)) return new(Key: null);
        // Invalid configuration disables only the optional widget, never the existing feeds/API.
        if (!Regex.IsMatch(key, @"\A[A-Za-z0-9_-]{32,256}\z") ||
            EnvelopeCrypto.Matches(key, bridge.ApiKey) || EnvelopeCrypto.Matches(key, bridge.FeedToken))
            return new(null, true);
        return new(key);
    }
    public bool Allows(string? candidate) => Key is not null && candidate is { Length: >= 32 and <= 256 } &&
        EnvelopeCrypto.Matches(candidate, Key);
}
