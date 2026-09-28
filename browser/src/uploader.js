import { encryptCalendarPayload } from "./crypto.js";

let cachedKey;
export function apiOrigin(base) {
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
    throw new Error("The API address must be an HTTPS origin, without a path.");
  return url.origin;
}
async function request(url, options, fetchImpl) {
  const abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 20000);
  try {
    return await fetchImpl(url, { ...options, signal: abort.signal, credentials: "omit",
      referrerPolicy: "no-referrer", redirect: "error", mode: "cors", cache: "no-store" });
  } catch {
    throw new Error("Connection failed or timed out. Check Outlook CSP, CORS and service availability. No automatic retry was made.");
  } finally { clearTimeout(timeout); }
}
export async function uploadCalendar(payload, config, fetchImpl = globalThis.fetch, cryptoApi = globalThis.crypto) {
  const origin = apiOrigin(config.API_BASE_URL);
  const calendarName = config.CALENDAR_NAME || "default";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(calendarName)) throw new Error("Use a calendar name with lowercase letters, digits, hyphens or underscores (1–64 characters).");
  payload = { ...payload, calendarName };
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.API_KEY || "")) throw new Error("Enter the calendar upload API key.");
  if (!cachedKey || cachedKey.origin !== origin || cachedKey.expires <= Date.now()) {
    const response = await request(origin + "/api/v1/crypto/public-key", { method: "GET" }, fetchImpl);
    if (!response.ok) throw new Error("Could not retrieve the encryption public key.");
    const key = await response.json();
    if (key.algorithm !== "RSA-OAEP-256" || !/^[A-Za-z0-9_-]{1,64}$/.test(key.keyId || "") ||
        key.jwk?.kty !== "RSA" || key.jwk?.d) throw new Error("Invalid public encryption key.");
    cachedKey = { origin, key, expires: Date.now() + 300000 };
  }
  // This is the only POST path. Encryption failure stops here, with no plaintext fallback.
  const envelope = await encryptCalendarPayload(payload, cachedKey.key.jwk, cachedKey.key.keyId, cryptoApi);
  const body = JSON.stringify(envelope);
  if (new TextEncoder().encode(body).length > (config.MAX_PAYLOAD_BYTES || 262144))
    throw new Error("Encrypted snapshot is too large. Use a smaller visible calendar range.");
  const response = await request(origin + "/api/v1/calendar/sync?calendar=" + encodeURIComponent(calendarName), {
    method: "POST", headers: { "Content-Type": "application/json", "X-API-Key": config.API_KEY }, body
  }, fetchImpl);
  if (!response.ok) {
    if (response.status === 400) cachedKey = undefined;
    const messages = { 400: "The server rejected the encrypted snapshot. Re-scan and check dates and parser output.",
      401: "The API key was rejected.", 409: "A newer or identical snapshot already covers these dates. Re-scan before uploading.",
      413: "The snapshot exceeds the server size limit.", 429: "Upload rate limit reached. Wait one minute.",
      503: "Calendar storage is temporarily unavailable." };
    throw new Error(messages[response.status] || "Upload failed. Check service availability.");
  }
  return response.json();
}
