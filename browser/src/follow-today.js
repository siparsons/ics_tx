import { getVisibleDateRange, diagnostics } from "./outlook-extractor.js";

const DAY_SURFACE = '[data-app-section="Surface_Day"]';
const NAVIGATION = '[data-app-section="CalendarSurfaceNavigationToolbar"]';
function localDay(date) { return [date.getFullYear(), date.getMonth(), date.getDate()].join("-"); }
function shown(el) { return el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"]'); }
function includesToday(range, today) {
  const midnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return range && Date.parse(range.windowStart) <= +midnight && Date.parse(range.windowEnd) > +midnight;
}

// Navigation only changes the calendar view, never appointments or calendar selection.
export function createTodayFollower({ now = () => new Date(),
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)), timeoutMs = 15000,
  onNavigate = () => {} } = {}) {
  let followedDay = null;
  return async function followToday(root = document) {
    if (![...root.querySelectorAll(DAY_SURFACE)].some(shown)) return;
    const today = now(), day = localDay(today);
    if (day === followedDay) return;
    const buttons = [...root.querySelectorAll(NAVIGATION + ' button, ' + NAVIGATION + ' [role="button"]')]
      .filter(shown).filter(el => /^Go to today(?:\s|$)/i.test(el.getAttribute("aria-label") || el.getAttribute("title") || ""));
    if (buttons.length !== 1) throw new Error("Cannot identify Outlook's Go to today button. No calendar was uploaded.");
    const button = buttons[0];
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      if (!includesToday(getVisibleDateRange(root), today)) throw new Error("Outlook cannot return to today. No calendar was uploaded.");
    } else {
      onNavigate();
      button.click();
    }
    let previous = null, stableFor = 0;
    // Require a valid current-day window and a quiet calendar after navigation.
    // Busy or changing views are never uploaded as an empty replacement.
    for (let elapsed = 0; elapsed < timeoutMs; elapsed += 250) {
      await wait(250);
      const surface = [...root.querySelectorAll(DAY_SURFACE)].find(shown);
      const range = surface && getVisibleDateRange(root);
      const busy = surface && (surface.getAttribute("aria-busy") === "true" ||
        [...surface.querySelectorAll('[aria-busy="true"], [role="progressbar"]')].some(shown));
      if (!surface || busy || !includesToday(range, today)) { previous = null; stableFor = 0; continue; }
      const signature = JSON.stringify([range, diagnostics(surface)]);
      stableFor = signature === previous ? stableFor + 250 : 0;
      previous = signature;
      if (elapsed >= 1500 && stableFor >= 1000) { followedDay = day; return; }
    }
    throw new Error("Outlook's view has not settled on today. No calendar was uploaded; the next scheduled run will try again.");
  };
}
