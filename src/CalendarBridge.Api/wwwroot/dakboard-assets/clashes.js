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
export function createClashWidget({ document: doc, location, fetch: fetchData = globalThis.fetch,
  now = () => new Date(), setInterval: repeat = globalThis.setInterval, clearInterval: stopRepeat = globalThis.clearInterval,
  setTimeout: later = globalThis.setTimeout, clearTimeout: stopLater = globalThis.clearTimeout } = {}) {
  const node = id => doc.getElementById(id);
  const panel = node("clash-panel"), unavailable = node("unavailable");
  const endpoint = location.pathname.replace(/\/+$/, "") + "/data";
  let clashes = [], calendars = [], index = 0, failed = false, pending = false, stopped = false;
  let rotationTimer, refreshTimer, abortTimer, controller;
  function prune() {
    const id = clashes[index]?.id;
    clashes = clashes.filter(c => Date.parse(c.overlapEnd) > +now());
    index = Math.max(0, clashes.findIndex(c => c.id === id));
  }
  function render() {
    prune();
    unavailable.hidden = !failed;
    panel.hidden = failed || clashes.length === 0;
    if (panel.hidden) return;
    const clash = clashes[index];
    node("overlap-amount").textContent = `${new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 }).format(clash.overlapMinutes)} MIN OVERLAP`;
    node("overlap-time").textContent = overlapLabel(clash, now());
    for (const side of ["first", "second"]) {
      // Calendar-controlled strings are always rendered as text, never HTML.
      node(side + "-title").textContent = clash[side].displayTitle;
      node(side + "-time").textContent = appointmentTime(clash[side], clash, now());
    }
    panel.classList.toggle("spans-dates", ["first", "second"].some(side => node(side + "-time").textContent.includes("\n")));
    const freshness = captureFreshness(clash, calendars, now());
    node("freshness").hidden = !freshness;
    node("freshness").textContent = freshness?.label || "";
    node("freshness").classList.toggle("stale", !!freshness?.stale);
    node("clash-count").hidden = clashes.length <= 1;
    node("clash-count").textContent = clashes.length > 1 ? `${index + 1} of ${clashes.length} clashes` : "";
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
      const currentId = clashes[index]?.id;
      clashes = next.clashes;
      calendars = next.calendars;
      index = Math.max(0, clashes.findIndex(c => c.id === currentId));
      failed = false;
    } catch {
      if (!stopped) failed = true;
    } finally {
      stopLater(abortTimer);
      controller = null;
      pending = false;
      if (!stopped) render();
    }
  }
  function rotate() {
    if (stopped) return;
    prune();
    if (!failed && clashes.length > 1) index = (index + 1) % clashes.length;
    render();
  }
  function start() {
    if (rotationTimer !== undefined || refreshTimer !== undefined) return;
    stopped = false;
    render();
    rotationTimer = repeat(rotate, 11000);
    refreshTimer = repeat(() => { void refresh(); }, 60000);
    void refresh();
  }
  function stop() {
    stopped = true;
    stopRepeat(rotationTimer); stopRepeat(refreshTimer); stopLater(abortTimer);
    rotationTimer = refreshTimer = undefined;
    controller?.abort();
  }
  return { start, stop, refresh, rotate };
}
if (typeof window !== "undefined" && window.document?.getElementById("widget")) {
  const widget = createClashWidget({ document: window.document, location: window.location });
  widget.start();
  window.addEventListener("pagehide", () => widget.stop(), { once: true });
}
