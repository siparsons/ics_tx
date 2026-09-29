import { assertOutlook, diagnostics, extractCalendarEvents, getVisibleDateRange,
  goToNextPeriod, goToPreviousPeriod, strictTimestamp } from "./outlook-extractor.js";
import { apiOrigin, uploadCalendar } from "./uploader.js";
import { createUi } from "./ui.js";
import { loadInterval, saveInterval, schedulePreferenceKey, validInterval } from "./schedule-preference.js";
import { createScheduler } from "./scheduler.js";
import { openCompanion } from "./companion-client.js";

const scriptUrl = document.currentScript?.src ? new URL(document.currentScript.src) : null;
const defaults = { API_BASE_URL: scriptUrl?.origin || __API_BASE_URL__, API_KEY: __API_KEY__,
  CALENDAR_NAME: scriptUrl?.searchParams.get("calendar") || __CALENDAR_NAME__ };
let active = false;
let scheduler;
let companion, companionError;
function timerStatus(ui) {
  const status = scheduler?.status();
  if (!status?.enabled) return;
  const next = new Date(status.nextRun).toLocaleString("en-GB", { weekday: "short", hour: "2-digit", minute: "2-digit" });
  ui.text("Timer active: every " + status.intervalMinutes + " minute" + (status.intervalMinutes === 1 ? "" : "s") + ". Next: " + next + ". Keep this calendar open.");
  ui.button("Stop timer", () => { scheduler.stop(); ui.clear(); ui.text("Automatic sync stopped."); });
}
function showError(ui, error) {
  ui.clear(); ui.text("Calendar sync failed");
  ui.text(error.message || "The operation failed.");
  ui.button("Diagnostics", runDiagnostics);
  timerStatus(ui);
}
export function runDiagnostics() {
  const ui = createUi();
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
  active = true;
  const ui = createUi({ notification: true });
  try {
    assertOutlook();
    if (!globalThis.crypto?.subtle) throw new Error("Web Crypto is unavailable.");
    ui.text("Scanning calendar…");
    const config = { ...defaults, ...overrides };
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(config.API_KEY || ""))
      throw new Error("This Favourite has no upload key. Install the private bookmarklet-with-key.txt generated with API_KEY.");
    const events = extractCalendarEvents();
    const capturedAt = new Date().toISOString();
    const detected = getVisibleDateRange();
    if (!(config.windowStart || detected?.windowStart) || !(config.windowEnd || detected?.windowEnd))
      throw new Error("Cannot determine the calendar window. Open a complete month view and try again.");
    const windowStart = strictTimestamp(config.windowStart || detected.windowStart);
    const windowEnd = strictTimestamp(config.windowEnd || detected.windowEnd);
    if (Date.parse(windowEnd) <= Date.parse(windowStart) || Date.parse(windowEnd) - Date.parse(windowStart) > 366 * 86400000)
      throw new Error("Use a valid calendar window of at most 366 days.");
    if (events.some(e => Date.parse(e.start) < Date.parse(windowStart) || Date.parse(e.start) >= Date.parse(windowEnd)))
      throw new Error("The calendar window does not include every captured event.");
    if (companionError) throw companionError;
    if (!companion?.isOpen() || companion.origin !== apiOrigin(config.API_BASE_URL))
      throw new Error("Keep the Calendar Bridge companion tab open. Click the Favourite to reconnect it.");
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    ui.clear(); ui.text("Encrypting and uploading " + events.length + " events…");
    const result = await uploadCalendar({ version: 1, source: "outlook-web-bookmarklet",
      capturedAt, windowStart, windowEnd, timezone, events }, config, companion.fetch);
    ui.clear(); ui.text("✓ " + result.eventCount + " events synced to " + config.CALENDAR_NAME);
    timerStatus(ui);
    setTimeout(() => ui.close(), 5000);
  } catch (e) { showError(ui, e); }
  finally { active = false; }
}

// A second click can evaluate a new copy of the bundle while the first is uploading.
if (!globalThis.CalendarBridge?.isRunning?.()) {
  const previous = globalThis.CalendarBridge;
  previous?.stopSchedule?.();
  companion = previous?.getCompanion?.();
  scheduler = createScheduler(() => run(), { isBusy: () => active });
  globalThis.CalendarBridge = { run, runDiagnostics, isRunning: () => active,
    stopSchedule: () => scheduler.stop(), scheduleStatus: () => scheduler.status(), getCompanion: () => companion,
    extractCalendarEvents, getVisibleDateRange, goToNextPeriod, goToPreviousPeriod };
  // Do not arm a public/keyless bookmark or a non-calendar page.
  let configured = /^[A-Za-z0-9_-]{32,256}$/.test(defaults.API_KEY || "");
  try { assertOutlook(); } catch { configured = false; }
  function startWithInterval(minutes) {
    scheduler.stop();
    scheduler = createScheduler(() => run(), { isBusy: () => active, intervalMinutes: minutes });
    // Called directly by the Favourite or Start button so the popup retains user activation.
    try {
      const origin = apiOrigin(defaults.API_BASE_URL);
      if (!companion?.isOpen() || companion.origin !== origin) {
        companion?.dispose();
        companion = openCompanion(origin);
      }
    } catch (error) { companionError = error; }
    if (companionError) void run();
    else void scheduler.start();
  }
  if (configured) {
    try {
      const key = schedulePreferenceKey(defaults.API_BASE_URL, defaults.CALENDAR_NAME);
      const saved = loadInterval(globalThis.localStorage, key);
      if (saved !== null) startWithInterval(saved);
      else {
        const ui = createUi();
        ui.text("How often should calendar " + defaults.CALENDAR_NAME + " sync? Your choice is remembered in this browser for this Outlook site.");
        const input = ui.field("Run every (minutes)", "15", "number");
        input.min = "1"; input.max = "10080"; input.step = "1";
        const errorText = ui.text("");
        ui.button("Save and start", () => {
          const minutes = Number(input.value);
          if (!validInterval(minutes)) {
            errorText.textContent = "Enter a whole number from 1 to 10080 minutes.";
            return;
          }
          try { saveInterval(globalThis.localStorage, key, minutes); }
          catch { errorText.textContent = "The browser could not save your choice. Allow site storage for Outlook and try again."; return; }
          ui.close();
          startWithInterval(minutes);
        });
      }
    } catch (error) {
      showError(createUi(), new Error("Could not read the saved sync frequency. Allow site storage for Outlook and click the Favourite again."));
    }
  }
  else void run();
}
