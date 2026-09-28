import { assertOutlook, diagnostics, extractCalendarEvents, getVisibleDateRange,
  goToNextPeriod, goToPreviousPeriod, strictTimestamp } from "./outlook-extractor.js";
import { uploadCalendar } from "./uploader.js";
import { createUi } from "./ui.js";

const scriptUrl = document.currentScript?.src ? new URL(document.currentScript.src) : null;
const defaults = { API_BASE_URL: scriptUrl?.origin || __API_BASE_URL__, API_KEY: __API_KEY__,
  CALENDAR_NAME: scriptUrl?.searchParams.get("calendar") || __CALENDAR_NAME__ };
let active = false;
let activeUi;
function showError(ui, error) {
  ui.clear(); ui.text("Calendar sync failed");
  ui.button("View details", () => ui.text(error.message || "The operation failed."));
  ui.button("Diagnostics", runDiagnostics);
}
export function runDiagnostics() {
  const ui = createUi(); activeUi = ui;
  try {
    assertOutlook();
    const values = diagnostics();
    ui.text(values.length + " appointment candidates. Diagnostics stay in this page. Review and redact before sharing.");
    const area = ui.showJson(values);
    ui.button("Copy", async () => {
      try { await navigator.clipboard.writeText(area.value); ui.text("Copied."); }
      catch { area.focus(); area.select(); ui.text("Clipboard access blocked. Press Ctrl+C to copy."); }
    });
  } catch (e) { showError(ui, e); }
}
export async function run(overrides = {}) {
  if (active) return;
  const ui = createUi(); activeUi = ui;
  try {
    assertOutlook();
    if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable.");
    ui.text("Scanning calendar…");
    const events = extractCalendarEvents();
    const detected = getVisibleDateRange();
    const config = { ...defaults, ...overrides };
    ui.clear();
    ui.text("Found " + events.length + " events. Review every event and the replacement window.");
    ui.text("Only rendered appointments are captured. Scroll and expand the view first. An incomplete capture would remove missing events in these dates.");
    ui.showJson(events);
    const base = ui.field("Bridge HTTPS address", config.API_BASE_URL);
    const calendarName = ui.field("Calendar name", config.CALENDAR_NAME);
    const apiKey = ui.field("Upload API key (kept only in memory)", config.API_KEY, "password");
    const start = ui.field("Window start (ISO timestamp with offset)", config.windowStart || detected?.windowStart || "");
    const end = ui.field("Window end, exclusive (ISO timestamp with offset)", config.windowEnd || detected?.windowEnd || "");
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    ui.text("Interpreted timezone: " + timezone + ". It must match Outlook for appointments without explicit offsets.");
    const confirmed = ui.field("I checked the dates and timezone; every appointment in this window is shown above.", "", "checkbox");
    const empty = events.length ? null : ui.field("This window is empty; remove its previously synced events.", "", "checkbox");
    // Capture time belongs to enumeration, not to a later upload click.
    const capturedAt = new Date().toISOString();
    const submit = ui.button("Encrypt and sync", async () => {
      if (active || activeUi !== ui) return;
      try {
        if (!confirmed.checked || (empty && !empty.checked)) throw new Error("Confirm the full snapshot before uploading.");
        const windowStart = strictTimestamp(start.value);
        const windowEnd = strictTimestamp(end.value);
        if (+new Date(windowEnd) <= +new Date(windowStart) || Date.parse(windowEnd) - Date.parse(windowStart) > 366 * 86400000)
          throw new Error("Use a valid window of at most 366 days.");
        if (events.some(e => Date.parse(e.start) < Date.parse(windowStart) || Date.parse(e.start) >= Date.parse(windowEnd)))
          throw new Error("The window must include the start of every captured event.");
        active = true; submit.disabled = true;
        ui.text("Encrypting and uploading…");
        const result = await uploadCalendar({ version: 1, source: "outlook-web-bookmarklet",
          capturedAt, windowStart, windowEnd, timezone, events },
        { ...config, API_BASE_URL: base.value.trim(), API_KEY: apiKey.value.trim(), CALENDAR_NAME: calendarName.value.trim() });
        apiKey.value = "";
        ui.clear(); ui.text("✓ " + result.eventCount + " events synced");
      } catch (e) { showError(ui, e); }
      finally { active = false; }
    });
    ui.button("Diagnostics", runDiagnostics);
  } catch (e) { showError(ui, e); }
}
globalThis.CalendarBridge = { run, runDiagnostics, extractCalendarEvents, getVisibleDateRange, goToNextPeriod, goToPreviousPeriod };
run();
