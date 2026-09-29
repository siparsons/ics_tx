const timeFormat = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
const dayKey = date => [date.getFullYear(), date.getMonth(), date.getDate()].join("-");
const instant = value => {
  const date = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(+date)) throw new Error("Invalid date");
  return date;
};
export function dateLabel(date, now = new Date()) {
  if (dayKey(date) === dayKey(now)) return "Today";
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  if (dayKey(date) === dayKey(tomorrow)) return "Tomorrow";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short",
    ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) }).format(date).replaceAll(",", "");
}
export function overlapLabel(clash, now = new Date()) {
  const start = instant(clash.overlapStart), end = instant(clash.overlapEnd);
  return dayKey(start) === dayKey(end)
    ? `${dateLabel(start, now)} · ${timeFormat.format(start)}–${timeFormat.format(end)}`
    : `${dateLabel(start, now)} · ${timeFormat.format(start)} – ${dateLabel(end, now)} · ${timeFormat.format(end)}`;
}
export function appointmentTime(event, clash, now = new Date()) {
  const start = instant(event.start), end = instant(event.end), overlap = instant(clash.overlapStart);
  if (dayKey(start) === dayKey(end) && dayKey(start) === dayKey(overlap))
    return `${timeFormat.format(start)}–${timeFormat.format(end)}`;
  return `${dateLabel(start, now)} ${timeFormat.format(start)}\n– ${dateLabel(end, now)} ${timeFormat.format(end)}`;
}
export function captureFreshness(clash, calendars, now = new Date()) {
  const names = [...new Set([clash.first.calendarName, clash.second.calendarName])];
  const times = names.map(name => {
    const match = calendars.find(calendar => calendar.name === name);
    return match?.lastCapturedAt ? Date.parse(match.lastCapturedAt) : NaN;
  });
  if (times.some(time => !Number.isFinite(time) || time > +now)) return null;
  const minutes = Math.floor((+now - Math.min(...times)) / 60000);
  const age = minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min${minutes === 1 ? "" : "s"} ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)} hour${minutes < 120 ? "" : "s"} ago`
      : `${Math.floor(minutes / 1440)} day${minutes < 2880 ? "" : "s"} ago`;
  return { label: "captured " + age, stale: minutes >= 30 };
}
function validatedReport(value) {
  if (!value || !Array.isArray(value.clashes) || !Array.isArray(value.calendars)) throw new Error("Invalid report");
  const ids = new Set();
  for (const clash of value.clashes) {
    if (typeof clash.id !== "string" || !clash.id || ids.has(clash.id) ||
      !(instant(clash.overlapEnd) > instant(clash.overlapStart)) ||
      !Number.isFinite(clash.overlapMinutes) || clash.overlapMinutes <= 0) throw new Error("Invalid clash");
    ids.add(clash.id);
    for (const event of [clash.first, clash.second]) {
      if (!event || typeof event.calendarName !== "string" || typeof event.displayTitle !== "string" ||
        !(instant(event.end) > instant(event.start))) throw new Error("Invalid appointment");
    }
  }
  if (value.calendars.some(c => !c || typeof c.name !== "string")) throw new Error("Invalid calendar");
  return { calendars: value.calendars, clashes: [...value.clashes].sort((a, b) =>
    Date.parse(a.overlapStart) - Date.parse(b.overlapStart) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) };
}
// Day boundaries follow the display's local timezone, including DST changes.
export function splitClashes(clashes, now = new Date()) {
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const upcoming = clashes.filter(c => Date.parse(c.overlapEnd) > +now);
  return { today: upcoming.filter(c => Date.parse(c.overlapStart) < +tomorrow),
    future: upcoming.filter(c => Date.parse(c.overlapStart) >= +tomorrow) };
}
export function createClashWidget({ document: doc, location, fetch: fetchData = globalThis.fetch,
  now = () => new Date(), setInterval: repeat = globalThis.setInterval, clearInterval: stopRepeat = globalThis.clearInterval,
  setTimeout: later = globalThis.setTimeout, clearTimeout: stopLater = globalThis.clearTimeout,
  ResizeObserver: Observer = globalThis.ResizeObserver } = {}) {
  const node = id => doc.getElementById(id);
  const panel = node("clash-panel"), grid = node("today-grid"), futurePanel = node("future-panel"), track = node("ticker-track");
  const endpoint = location.pathname.replace(/\/+$/, "") + "/data";
  const tiles = new Map();
  let clashes = [], calendars = [], failed = false, pending = false, stopped = false, tickerSignature = "";
  let clockTimer, refreshTimer, abortTimer, controller, observer;
  const number = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
  function element(tag, className, text) {
    const el = doc.createElement(tag); el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }
  function setText(el, value) { if (el.textContent !== value) el.textContent = value; }
  function createTile(id) {
    const tile = element("article", "clash-tile"); tile.setAttribute("role", "listitem"); tile.dataset.clashId = id;
    const heading = element("div", "tile-heading"), state = element("span", "clash-state"), amount = element("span", "overlap-amount");
    heading.append(state, amount);
    const time = element("h2", "overlap-time"), events = element("ol", "appointments"), sides = {};
    events.setAttribute("aria-label", "Conflicting appointments");
    for (const side of ["first", "second"]) {
      const row = element("li", "appointment"), title = element("span", "event-title"), time = element("span", "event-time");
      row.append(title, time); events.append(row); sides[side] = { title, time };
    }
    const freshness = element("span", "freshness");
    tile.append(heading, time, events, freshness);
    return { tile, state, amount, time, sides, freshness };
  }
  function layout() {
    const width = grid.clientWidth || doc.documentElement.clientWidth || 960;
    const count = tiles.size;
    const maxColumns = Math.min(count || 1, 3, Math.max(1, Math.floor(width / 360)));
    const rows = Math.ceil((count || 1) / maxColumns);
    const columns = Math.ceil((count || 1) / rows);
    const root = node("widget");
    root.style.setProperty("--columns", String(columns)); root.style.setProperty("--rows", String(rows));
    const height = grid.clientHeight || 180;
    const spansDates = [...tiles.values()].some(t => t.tile.classList.contains("spans-dates"));
    let type = Math.max(1, Math.min(32, (width - (columns - 1) * 10) / columns / 23,
      (height - (rows - 1) * 10) / rows / (spansDates ? 10 : 8)));
    root.classList.toggle("compact-tiles", type < 16);
    root.style.setProperty("--tile-type", type + "px");
    // Fit the actual content as well as the estimated row height (fonts and dates vary).
    for (let attempt = 0; attempt < 3; attempt++) {
      let ratio = 1;
      for (const { tile } of tiles.values()) {
        if (tile.clientHeight > 0 && tile.scrollHeight > tile.clientHeight + 1)
          ratio = Math.min(ratio, tile.clientHeight / tile.scrollHeight);
        if (tile.clientWidth > 0 && tile.scrollWidth > tile.clientWidth + 1)
          ratio = Math.min(ratio, tile.clientWidth / tile.scrollWidth);
      }
      if (ratio === 1) break;
      type = Math.max(1, type * ratio * .96);
      root.classList.toggle("compact-tiles", type < 16);
      root.style.setProperty("--tile-type", type + "px");
    }
    const group = track.firstElementChild;
    if (group) track.style.setProperty("--ticker-duration", Math.max(20, (group.scrollWidth || 900) / 45) + "s");
  }
  function renderTicker(future) {
    futurePanel.hidden = future.length === 0;
    setText(node("future-heading"), "COMING UP " + future.length);
    // Preserve the moving strip across identical refreshes and clock ticks.
    const content = future.map(c => [overlapLabel(c, now()), c.first.displayTitle, appointmentTime(c.first, c, now()),
      c.second.displayTitle, appointmentTime(c.second, c, now()), number.format(c.overlapMinutes)]);
    const signature = JSON.stringify(content);
    if (signature === tickerSignature) return;
    tickerSignature = signature;
    track.replaceChildren();
    if (!future.length) return;
    const group = element("div", "ticker-group"); group.setAttribute("role", "list");
    for (const [date, first, firstTime, second, secondTime, duration] of content) {
      const item = element("div", "ticker-item"); item.setAttribute("role", "listitem");
      item.append(element("span", "ticker-date", date), element("span", "ticker-duration", duration + " MIN OVERLAP"),
        element("span", "ticker-detail", first + " (" + firstTime.replaceAll("\n", " ") + ") / " + second + " (" + secondTime.replaceAll("\n", " ") + ")"));
      group.append(item);
    }
    const duplicate = group.cloneNode(true); duplicate.setAttribute("aria-hidden", "true");
    track.append(group, duplicate);
  }
  function render() {
    const { today, future } = splitClashes(clashes, now());
    node("unavailable").hidden = !failed;
    node("cached-notice").hidden = !failed || today.length === 0;
    panel.hidden = today.length === 0;
    setText(node("clash-heading"), "\u26a0 " + today.length + (today.length === 1 ? " CLASH TODAY" : " CLASHES TODAY"));
    const ids = new Set(today.map(c => c.id));
    for (const [id, refs] of tiles) if (!ids.has(id)) { refs.tile.remove(); tiles.delete(id); }
    today.forEach((clash, index) => {
      let refs = tiles.get(clash.id);
      if (!refs) { refs = createTile(clash.id); tiles.set(clash.id, refs); }
      if (grid.children[index] !== refs.tile) grid.insertBefore(refs.tile, grid.children[index] || null);
      const active = Date.parse(clash.overlapStart) <= +now();
      refs.tile.classList.toggle("is-now", active);
      setText(refs.state, active ? "CLASH NOW" : "CLASH TODAY");
      setText(refs.amount, number.format(clash.overlapMinutes) + " MIN OVERLAP");
      setText(refs.time, overlapLabel(clash, now()).replace(/^Today \u00b7 /, ""));
      for (const side of ["first", "second"]) {
        // Event titles and ticker content always use safe text nodes.
        setText(refs.sides[side].title, clash[side].displayTitle);
        refs.sides[side].title.title = clash[side].displayTitle;
        setText(refs.sides[side].time, appointmentTime(clash[side], clash, now()));
      }
      refs.tile.classList.toggle("spans-dates", ["first", "second"].some(side => refs.sides[side].time.textContent.includes("\n")));
      const freshness = captureFreshness(clash, calendars, now());
      refs.freshness.hidden = !freshness;
      setText(refs.freshness, freshness?.label || "");
      refs.freshness.classList.toggle("stale", !!freshness?.stale);
    });
    renderTicker(future);
    layout();
  }
  async function refresh() {
    if (pending || stopped) return;
    pending = true;
    controller = new AbortController();
    abortTimer = later(() => controller?.abort(), 15000);
    try {
      const response = await fetchData(endpoint, { cache: "no-store", credentials: "omit", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("Unavailable");
      const next = validatedReport(await response.json());
      if (stopped) return;
      clashes = next.clashes; calendars = next.calendars; failed = false;
    } catch {
      if (!stopped) failed = true;
    } finally {
      stopLater(abortTimer); controller = null; pending = false;
      if (!stopped) render();
    }
  }
  function tick() { if (!stopped) render(); }
  function start() {
    if (clockTimer !== undefined || refreshTimer !== undefined) return;
    stopped = false;
    render();
    clockTimer = repeat(tick, 15000);
    refreshTimer = repeat(() => { void refresh(); }, 60000);
    if (Observer) { observer = new Observer(layout); observer.observe(node("widget")); }
    void refresh();
  }
  function stop() {
    stopped = true;
    stopRepeat(clockTimer); stopRepeat(refreshTimer); stopLater(abortTimer);
    clockTimer = refreshTimer = undefined;
    observer?.disconnect(); observer = null;
    controller?.abort();
  }
  return { start, stop, refresh, tick };
}
if (typeof window !== "undefined" && window.document?.getElementById("widget")) {
  const widget = createClashWidget({ document: window.document, location: window.location });
  widget.start();
  window.addEventListener("pagehide", () => widget.stop(), { once: true });
}
