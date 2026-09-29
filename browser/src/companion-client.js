export function openCompanion(origin, win = globalThis) {
  const channel = [...win.crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, "0")).join("");
  const popup = win.open(origin + "/bookmark/companion.html#channel=" + channel +
    "&origin=" + encodeURIComponent(win.location.origin), "_blank");
  if (!popup) throw new Error("Edge blocked the Calendar Bridge companion tab. Allow pop-ups for Outlook and click the Favourite again.");
  const pending = new Map();
  let ready = false, polling;
  function send(value) { popup.postMessage({ ...value, channel }, origin); }
  function finish(id, error, response) {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    request.signal?.removeEventListener("abort", request.abort);
    if (!pending.size) clearTimeout(polling);
    if (error) request.reject(error); else request.resolve(response);
  }
  function dispatch() {
    for (const [id, request] of pending) {
      if (request.sent) continue;
      request.sent = true;
      send({ type: "calendar-bridge:request", id, ...request.message });
    }
  }
  function poll() {
    clearTimeout(polling);
    if (!pending.size) return;
    if (popup.closed) {
      for (const id of pending.keys()) finish(id, new Error("Companion tab closed or isolated by browser policy."));
      return;
    }
    send({ type: "calendar-bridge:hello" });
    polling = setTimeout(poll, 250);
  }
  const onMessage = event => {
    const data = event.data;
    if (event.source !== popup || event.origin !== origin || data?.channel !== channel) return;
    if (data.type === "calendar-bridge:ready") {
      ready = true; clearTimeout(polling); dispatch();
    } else if (data.type === "calendar-bridge:response" && pending.has(data.id)) {
      if (!Number.isInteger(data.status) || data.status < 100 || data.status > 599) return;
      finish(data.id, null, { ok: data.status >= 200 && data.status < 300, status: data.status,
        json: async () => data.result });
    }
  };
  win.addEventListener("message", onMessage);
  const transport = {
    origin,
    isOpen: () => !popup.closed,
    dispose() {
      clearTimeout(polling); win.removeEventListener("message", onMessage);
      for (const id of pending.keys()) finish(id, new Error("Companion connection replaced."));
    },
    fetch(url, options) {
      const target = new URL(url);
      if (target.origin !== origin) return Promise.reject(new Error("Companion destination mismatch."));
      if (popup.closed) return Promise.reject(new Error("Companion tab is closed. Click the Favourite to reopen it."));
      return new Promise((resolve, reject) => {
        const id = win.crypto.randomUUID();
        const abort = () => {
          if (pending.get(id)?.sent) send({ type: "calendar-bridge:cancel", id });
          finish(id, new Error("Companion request cancelled."));
        };
        pending.set(id, { resolve, reject, abort, signal: options.signal, sent: false,
          message: { method: options.method, path: target.pathname + target.search,
            body: options.body, apiKey: options.headers?.["X-API-Key"] } });
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) return abort();
        if (ready) dispatch(); else poll();
      });
    }
  };
  transport.fetch.companion = true;
  return transport;
}
