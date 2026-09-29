const OUTLOOK_ORIGINS = ["https://outlook.office.com", "https://outlook.office365.com"];
export function installCompanion(win, doc, fetchImpl = globalThis.fetch) {
  const config = new URLSearchParams(win.location.hash.slice(1));
  const channel = config.get("channel"), outlookOrigin = config.get("origin");
  const status = message => { doc.getElementById("status").textContent = message; };
  const record = (message, failed = false) => {
    const history = doc.getElementById("history");
    if (!history) return;
    doc.getElementById("history-empty")?.remove();
    const item = doc.createElement("li");
    const time = doc.createElement("time");
    time.dateTime = new Date().toISOString();
    time.textContent = new Date(time.dateTime).toLocaleString();
    const detail = doc.createElement("span");
    detail.textContent = message;
    item.className = failed ? "failed" : "success";
    item.append(time, detail);
    history.prepend(item);
    while (history.children.length > 100) history.lastElementChild.remove();
  };
  if (!win.opener || !OUTLOOK_ORIGINS.includes(outlookOrigin) || !/^[a-f0-9]{32}$/.test(channel || "")) {
    status("Open this companion from the Outlook Calendar Bridge Favourite. Browser window isolation may prevent the connection.");
    return () => {};
  }
  const inFlight = new Map(), seen = new Set();
  const reply = (id, code, result) => win.opener.postMessage({
    type: "calendar-bridge:response", channel, id, status: code, result
  }, outlookOrigin);
  const listener = async event => {
    const data = event.data;
    if (event.source !== win.opener || event.origin !== outlookOrigin || data?.channel !== channel) return;
    if (data.type === "calendar-bridge:hello") {
      win.opener.postMessage({ type: "calendar-bridge:ready", channel }, outlookOrigin);
      return;
    }
    if (typeof data.id !== "string" || !/^[a-zA-Z0-9-]{1,64}$/.test(data.id)) return;
    if (data.type === "calendar-bridge:cancel") { inFlight.get(data.id)?.abort(); return; }
    if (data.type !== "calendar-bridge:request" || seen.has(data.id)) return;
    if (seen.size >= 2000 || inFlight.size) { reply(data.id, 429, {}); return; }
    seen.add(data.id);
    let post = false;
    try {
      if (data.method === "GET" && data.path === "/api/v1/crypto/public-key" && data.body == null && data.apiKey == null) {
        // Public-key retrieval only.
      } else if (data.method === "POST" && /^\/api\/v1\/calendar\/sync\?calendar=[a-z0-9][a-z0-9_-]{0,63}$/.test(data.path)) {
        post = true;
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(data.apiKey || "") || typeof data.body !== "string" ||
            new TextEncoder().encode(data.body).length > 262144) throw new Error();
        const envelope = JSON.parse(data.body);
        if (!envelope || Object.keys(envelope).sort().join(",") !== "ciphertext,iv,keyId,version,wrappedKey" ||
            envelope.version !== 1 || !/^[A-Za-z0-9_-]{1,64}$/.test(envelope.keyId || "") ||
            !["ciphertext", "iv", "wrappedKey"].every(name => typeof envelope[name] === "string" &&
              /^[A-Za-z0-9_-]+$/.test(envelope[name]))) throw new Error();
      } else throw new Error();
    } catch { reply(data.id, 400, {}); return; }
    const controller = new AbortController(); inFlight.set(data.id, controller);
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      status(post ? "Uploading encrypted calendar…" : "Connected to Outlook. Retrieving public encryption key…");
      const response = await fetchImpl(win.location.origin + data.path, {
        method: data.method, credentials: "omit", redirect: "error", cache: "no-store",
        referrerPolicy: "no-referrer", signal: controller.signal,
        ...(post ? { headers: { "Content-Type": "application/json", "X-API-Key": data.apiKey }, body: data.body } : {})
      });
      const result = response.ok ? await response.json() : {};
      status(response.ok ? (post ? result.eventCount + " events synced. Last success: " + new Date().toLocaleString() :
        "Connected. Waiting for encrypted calendar.") : "Sync failed: HTTP " + response.status + ". Check the Outlook notification.");
      if (post || !response.ok) {
        const calendar = post ? new URLSearchParams(data.path.split("?")[1]).get("calendar") : "Public encryption key";
        record(response.ok ? calendar + ": " + result.eventCount + " events synced" :
          calendar + ": failed (HTTP " + response.status + ")", !response.ok);
      }
      reply(data.id, response.status, result);
    } catch {
      status("The service request failed or timed out. Check your connection and try the Favourite again.");
      record((post ? "Calendar upload" : "Public encryption key") + ": connection failed or timed out", true);
      reply(data.id, 503, {});
    } finally { clearTimeout(timer); inFlight.delete(data.id); }
  };
  win.addEventListener("message", listener);
  status("Ready. Keep this tab and the Outlook calendar open for scheduled uploads.");
  return () => { win.removeEventListener("message", listener); for (const controller of inFlight.values()) controller.abort(); };
}
if (typeof window !== "undefined" && window.location.pathname === "/bookmark/companion.html")
  installCompanion(window, document);