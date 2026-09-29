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
  const phase = options.method === "GET" ? "Encryption public-key request" : "Encrypted calendar upload";
  const origin = new URL(url).origin;
  let blockedByPolicy = false;
  const policyViolation = event => {
    if (event.disposition === "report") return;
    if (event.effectiveDirective !== "connect-src") return;
    try { if (new URL(event.blockedURI).origin === origin) blockedByPolicy = true; } catch { }
  };
  const doc = globalThis.document;
  doc?.addEventListener("securitypolicyviolation", policyViolation);
  const timeout = setTimeout(() => abort.abort(), 20000);
  try {
    return await fetchImpl(url, { ...options, signal: abort.signal, credentials: "omit",
      referrerPolicy: "no-referrer", redirect: "error", mode: "cors", cache: "no-store" });
  } catch {
    if (fetchImpl.companion)
      throw new Error(phase + " could not complete through the companion tab. Keep it open and verify " + origin +
        "/bookmark/companion.html is deployed. If the tab is blocked or browser policy isolates it from Outlook, the connection cannot be established. Click the Favourite to reconnect.");
    if (blockedByPolicy)
      throw new Error(phase + " blocked by Outlook's connect-src security policy for " + origin +
        ". A bookmarklet cannot override that policy. No automatic retry was made.");
    if (abort.signal.aborted)
      throw new Error(phase + " timed out after 20 seconds while contacting " + origin +
        ". Check the connection and service availability. No automatic retry was made.");
    throw new Error(phase + " could not connect to " + origin +
      " from " + (globalThis.location?.origin || "this page") +
      ". Edge's Console/Network panel can identify a CSP, CORS or network block. No automatic retry was made.");
  } finally {
    clearTimeout(timeout);
    doc?.removeEventListener("securitypolicyviolation", policyViolation);
  }
}
export async function uploadCalendar(payload, config, fetchImpl = globalThis.fetch, cryptoApi = globalThis.crypto) {
  const origin = apiOrigin(config.API_BASE_URL);
  const calendarName = config.CALENDAR_NAME || "default";
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(calendarName)) throw new Error("Use a calendar name with lowercase letters, digits, hyphens or underscores (1–64 characters).");
  payload = { ...payload, calendarName };
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.API_KEY || "")) throw new Error("Enter the calendar upload API key.");
  if (!cachedKey || cachedKey.origin !== origin || cachedKey.expires <= Date.now()) {
    const response = await request(origin + "/api/v1/crypto/public-key", { method: "GET" }, fetchImpl);
    if (!response.ok) throw new Error("Encryption public-key request returned HTTP " + response.status + ". Check service availability.");
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
