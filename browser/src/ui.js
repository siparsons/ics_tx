export function createUi({ notification = false } = {}) {
  document.getElementById("calendar-bridge-overlay")?.remove();
  const host = document.createElement("div");
  host.id = "calendar-bridge-overlay";
  host.style.cssText = "position:fixed;right:18px;top:18px;z-index:2147483647";
  const root = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = ":host{all:initial}section{font:14px system-ui;color:#172333;background:#fff;border:1px solid #8796aa;box-shadow:0 8px 36px #0004;border-radius:12px;padding:18px;width:380px;max-width:85vw;max-height:85vh;overflow:auto}h2{font-size:18px;margin:0 0 12px}button{padding:8px 12px;margin:8px 8px 0 0;border:1px solid #698099;border-radius:6px;background:#eef3fa;cursor:pointer}button:disabled{opacity:.5}label{display:block;margin-top:12px}input:not([type=checkbox]),textarea{box-sizing:border-box;width:100%;padding:7px;border:1px solid #8796aa;border-radius:4px}textarea{height:180px;font:12px monospace}p{line-height:1.45}input[type=checkbox]{margin-right:8px}";
  const panel = document.createElement("section");
  panel.setAttribute("role", notification ? "status" : "dialog");
  if (notification) { panel.setAttribute("aria-live", "polite"); panel.style.width = "300px"; }
  panel.setAttribute("aria-label", "Calendar Bridge");
  const title = document.createElement("h2"); title.textContent = "Calendar Bridge";
  const close = document.createElement("button"); close.textContent = "Close";
  close.onclick = () => host.remove();
  const body = document.createElement("div");
  root.append(style, panel); panel.append(title, body, close);
  document.documentElement.append(host);
  function text(value) { const p = document.createElement("p"); p.textContent = value; body.append(p); return p; }
  function button(label, action) {
    const b = document.createElement("button"); b.textContent = label; b.onclick = action; body.append(b); return b;
  }
  function field(label, value = "", type = "text") {
    const l = document.createElement("label"); l.textContent = label;
    const input = document.createElement("input"); input.type = type; input.value = value;
    input.autocomplete = "off"; if (type === "password") input.spellcheck = false;
    l.append(input); body.append(l); return input;
  }
  function showEvents(events, timezone) {
    const list = document.createElement("ol");
    list.setAttribute("aria-label", "Extracted appointments");
    const date = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short",
      day: "numeric", month: "short", year: "numeric" });
    const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    for (const event of events) {
      const item = document.createElement("li");
      item.style.marginBottom = "12px";
      const title = document.createElement("strong"); title.textContent = event.title;
      const when = document.createElement("div");
      const start = new Date(event.start), end = new Date(event.end);
      when.textContent = event.allDay
        ? date.format(start) + " — all day (ends " + date.format(end) + ", exclusive)"
        : date.format(start) + ", " + time.format(start) + " – " +
          (date.format(start) === date.format(end) ? "" : date.format(end) + ", ") + time.format(end);
      const location = document.createElement("div");
      location.textContent = event.location ? "Location: " + event.location : "Location not available in this view";
      item.append(title, when, location); list.append(item);
    }
    body.append(list);
    const details = document.createElement("details");
    const summary = document.createElement("summary"); summary.textContent = "Technical JSON (UTC times)";
    details.append(summary, showJson(events)); body.append(details);
  }
  function showJson(value) {
    const area = document.createElement("textarea"); area.value = JSON.stringify(value, null, 2);
    area.readOnly = true; area.setAttribute("aria-label", "Calendar Bridge data"); body.append(area); return area;
  }
  return { host, text, button, field, showJson, showEvents, clear: () => body.replaceChildren(), close: () => host.remove() };
}
