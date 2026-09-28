using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using CalendarBridge.Api.Configuration;
using CalendarBridge.Api.Models;

namespace CalendarBridge.Api.Crypto;

public sealed class EnvelopeCrypto : IDisposable
{
    private readonly RSA rsa = RSA.Create();
    private readonly object gate = new();
    private readonly string keyId;
    public static readonly byte[] Aad = Encoding.UTF8.GetBytes("calendar-bridge-v1");

    public EnvelopeCrypto(BridgeOptions options)
    {
        keyId = options.KeyId;
        try
        {
            var pem = options.PrivateKey.Trim();
            if (!pem.StartsWith("-----BEGIN", StringComparison.Ordinal))
                pem = Encoding.UTF8.GetString(Convert.FromBase64String(pem));
            rsa.ImportFromPem(pem.Replace("\\n", "\n", StringComparison.Ordinal));
            if (rsa.KeySize < 3072) throw new CryptographicException();
            var encrypted = rsa.Encrypt(new byte[32], RSAEncryptionPadding.OaepSHA256);
            CryptographicOperations.ZeroMemory(rsa.Decrypt(encrypted, RSAEncryptionPadding.OaepSHA256));
        }
        catch (Exception e) when (e is ArgumentException or FormatException or CryptographicException)
        {
            rsa.Dispose();
            throw new InvalidOperationException("CALENDAR_RSA_PRIVATE_KEY must contain a private RSA PEM key of at least 3072 bits.");
        }
    }

    public object PublicKey()
    {
        lock (gate)
        {
            var p = rsa.ExportParameters(false);
            return new { keyId, algorithm = "RSA-OAEP-256", jwk = new
                { kty = "RSA", n = Encode(p.Modulus!), e = Encode(p.Exponent!), alg = "RSA-OAEP-256", ext = true, key_ops = new[] { "encrypt" } } };
        }
    }

    public CalendarSnapshot Decrypt(EncryptedEnvelope envelope)
    {
        if (envelope.Version != 1 || envelope.KeyId != keyId) throw new CryptographicException();
        var iv = Decode(envelope.Iv);
        var wrapped = Decode(envelope.WrappedKey);
        var encrypted = Decode(envelope.Ciphertext);
        if (iv.Length != 12 || wrapped.Length != rsa.KeySize / 8 || encrypted.Length < 17)
            throw new CryptographicException();
        byte[]? aesKey = null;
        var plaintext = new byte[encrypted.Length - 16];
        try
        {
            lock (gate) aesKey = rsa.Decrypt(wrapped, RSAEncryptionPadding.OaepSHA256);
            if (aesKey.Length != 32) throw new CryptographicException();
            using var aes = new AesGcm(aesKey, 16);
            // Web Crypto returns ciphertext followed by the 128-bit GCM tag.
            aes.Decrypt(iv, encrypted.AsSpan(0, plaintext.Length), encrypted.AsSpan(plaintext.Length), plaintext, Aad);
            return JsonSerializer.Deserialize<CalendarSnapshot>(plaintext, WireJson.Options) ?? throw new JsonException();
        }
        finally
        {
            CryptographicOperations.ZeroMemory(plaintext);
            if (aesKey is not null) CryptographicOperations.ZeroMemory(aesKey);
            CryptographicOperations.ZeroMemory(encrypted);
            CryptographicOperations.ZeroMemory(wrapped);
            CryptographicOperations.ZeroMemory(iv);
        }
    }

    public static string Encode(byte[] value) => Convert.ToBase64String(value).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    public static byte[] Decode(string value)
    {
        if (string.IsNullOrEmpty(value) || value.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
            throw new FormatException();
        var normal = value.Replace('-', '+').Replace('_', '/');
        var bytes = Convert.FromBase64String(normal.PadRight((normal.Length + 3) / 4 * 4, '='));
        if (Encode(bytes) != value) throw new FormatException();
        return bytes;
    }

    public static bool Matches(string? provided, string expected) => CryptographicOperations.FixedTimeEquals(
        SHA256.HashData(Encoding.UTF8.GetBytes(provided ?? "")), SHA256.HashData(Encoding.UTF8.GetBytes(expected)));
    public void Dispose() => rsa.Dispose();
}
