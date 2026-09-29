const SELECTOR = [
  "[data-start][data-end]", "[data-start-time][data-end-time]",
  '[data-app-section="CalendarEvent"]', "[data-event-id]",
  '[role="button"][aria-label]', '[role="listitem"][aria-label]', '[role="gridcell"][aria-label]',
  'button[title]', '[role="button"][title]'
].join(",");
const DATA = ["data-start", "data-end", "data-start-time", "data-end-time",
  "data-subject", "data-title", "data-location", "data-all-day", "data-event-id", "data-date"];
const TIME_RANGE = /(\d{1,2}:\d{2}\s*(?:AM|PM)?)\s*(?:to|[-–])\s*(\d{1,2}:\d{2}\s*(?:AM|PM)?)/i;
const MONTHS = "january february march april may june july august september october november december".split(" ");

export function assertOutlook(location = globalThis.location) {
  if (location.protocol !== "https:" || !["outlook.office.com", "outlook.office365.com"].includes(location.hostname) ||
      !/\/calendar(?:\/|$)/i.test(location.pathname)) throw new Error("Open the Outlook Web calendar before running Calendar Bridge.");
}
function visible(el) {
  return el.getClientRects().length > 0 && !el.closest('[hidden], [aria-hidden="true"], #calendar-bridge-overlay');
}
export function enumerateCandidates(root = document) {
  return [...root.querySelectorAll(SELECTOR)].filter(visible).filter(el => {
    const label = (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("title") || "");
    return el.hasAttribute("data-start") || el.hasAttribute("data-start-time") ||
      el.hasAttribute("data-event-id") || el.getAttribute("data-app-section") === "CalendarEvent" ||
      /(?:\d{1,2}:\d{2}.*(?:to|[-–]).*\d{1,2}:\d{2}|all day.*\d{4})/i.test(label);
  }).filter((el, _, all) => !all.some(parent => parent !== el && parent.contains(el)));
}
export function candidateMetadata(el) {
  return {
    aria: el.getAttribute("aria-label") || "", title: el.getAttribute("title") || "",
    text: (el.innerText || "").slice(0, 2000), role: el.getAttribute("role") || "",
    data: Object.fromEntries(DATA.filter(name => el.hasAttribute(name)).map(name => [name, el.getAttribute(name)])),
    dateContext: el.closest("[data-date]")?.getAttribute("data-date") || ""
  };
}
export function diagnostics(root = document) {
  return enumerateCandidates(root).slice(0, 250).map(candidateMetadata);
}
function dateParts(text) {
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  m = /(?:^|,\s*|\s)(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:$|,|\s)/.exec(text);
  if (m && MONTHS.includes(m[2].toLowerCase())) return [+m[3], MONTHS.indexOf(m[2].toLowerCase()) + 1, +m[1]];
  m = /(?:^|,\s*|\s)([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})(?:$|,|\s)/.exec(text);
  if (m && MONTHS.includes(m[1].toLowerCase())) return [+m[3], MONTHS.indexOf(m[1].toLowerCase()) + 1, +m[2]];
  return null;
}
function localDate(parts, hour = 0, minute = 0) {
  const [y, m, d] = parts;
  const value = new Date(y, m - 1, d, hour, minute);
  if (value.getFullYear() !== y || value.getMonth() !== m - 1 || value.getDate() !== d ||
      value.getHours() !== hour || value.getMinutes() !== minute) throw new Error("Invalid or nonexistent local date/time.");
  // Reject ambiguous wall-clock times at a DST fold; explicit offsets are required then.
  for (const delta of [-120, -60, -30, 30, 60, 120]) {
    const other = new Date(+value + delta * 60000);
    if (other.getFullYear() === y && other.getMonth() === m - 1 && other.getDate() === d &&
        other.getHours() === hour && other.getMinutes() === minute)
      throw new Error("Ambiguous daylight-saving time. Explicit offsets are required.");
  }
  return value;
}
export function strictTimestamp(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value || ""))
    throw new Error("An ISO timestamp with seconds and an explicit offset is required.");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(value);
  const [, y, m, d, h, min, sec] = match.map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  if (m < 1 || m > 12 || d < 1 || d > days || h > 23 || min > 59 || sec > 59 || !Number.isFinite(Date.parse(value)))
    throw new Error("Invalid timestamp.");
  return new Date(value).toISOString();
}
function safeDisplay(value) {
  return (value || "").replace(/https?:\/\/\S+|www\.\S+|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gi, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();
}
function clock(value) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)?$/i.exec(value.trim());
  if (!m || +m[2] > 59 || +m[1] > (m[3] ? 12 : 23) || (m[3] && +m[1] < 1))
    throw new Error("Unsupported appointment time.");
  return [m[3] ? (+m[1] % 12) + (/PM/i.test(m[3]) ? 12 : 0) : +m[1], +m[2]];
}

// Parsing is deliberately independent of DOM enumeration. Add tenant fixtures before adding formats.
export function parseCandidate(meta) {
  const data = meta.data || {};
  let start = data["data-start"] || data["data-start-time"];
  let end = data["data-end"] || data["data-end-time"];
  const label = meta.aria || meta.title;
  const allDay = data["data-all-day"] === "true" || /\ball day\b/i.test(label);
  let title = data["data-subject"] || data["data-title"];
  let location = data["data-location"] || "";
  if (!start || !end) {
    const matches = [...label.matchAll(new RegExp(TIME_RANGE.source, "gi"))];
    const dated = matches.filter(m => dateParts(label.slice(m.index + m[0].length)));
    const timeMatch = dated.length === 1 ? dated[0] : matches.length === 1 ? matches[0] : null;
    if (!timeMatch) throw new Error("Appointment has no unambiguous time range.");
    const parts = dateParts(meta.dateContext || "") || dateParts(label.slice(timeMatch.index + timeMatch[0].length));
    if (!parts) throw new Error("Appointment has no unambiguous date with a year.");
    if (allDay) throw new Error("All-day appointments need explicit start and exclusive end metadata.");
    // AM/PM must be explicit on both endpoints or absent on both.
    if (/\b(?:AM|PM)\b/i.test(timeMatch[1]) !== /\b(?:AM|PM)\b/i.test(timeMatch[2]))
      throw new Error("Ambiguous AM/PM time range.");
    start = localDate(parts, ...clock(timeMatch[1])).toISOString();
    end = localDate(parts, ...clock(timeMatch[2])).toISOString();
    // The supported accessibility grammar has the subject first, before the time/date.
    const tooltip = (meta.title || "").split(/\r?\n/).map(line => line.trim());
    if (tooltip.length === 2 || tooltip.length === 3) {
      const times = new RegExp("^" + TIME_RANGE.source + "$", "i").exec(tooltip.at(-1));
      if (times) {
        if (JSON.stringify([clock(times[1]), clock(times[2])]) !==
            JSON.stringify([clock(timeMatch[1]), clock(timeMatch[2])]))
          throw new Error("Tooltip and accessibility times disagree.");
        const ariaSubject = label.slice(0, timeMatch.index).replace(/,\s*$/, "").trim();
        if (ariaSubject !== tooltip[0] &&
            ariaSubject.replace(/^Meeting icon,\s*/i, "") !== tooltip[0])
          throw new Error("Tooltip and accessibility subjects disagree.");
        title ||= tooltip[0];
        // Supported three-line tooltip: subject, location, time. Require the same
        // location in ARIA before the organizer, rather than copying arbitrary lines.
        if (tooltip.length === 3 && label.includes(", " + tooltip[1] + ", By "))
          location ||= tooltip[1];
      }
    }
    title ||= label.slice(0, timeMatch.index).replace(/,\s*$/, "").trim().replace(/^Meeting icon,\s*/i, "");
    if (dateParts(title) || /(?:organizer|attendees|body):/i.test(title))
      throw new Error("Unsupported subject format.");
    const locationMatch = /(?:^|,\s*)Location:\s*([^,]*)/i.exec(label);
    location ||= locationMatch?.[1] || "";
  }
  // Never derive a title from entire innerText or copy other metadata into the upload.
  if (!title) throw new Error("Appointment has no isolated subject.");
  start = strictTimestamp(start);
  end = strictTimestamp(end);
  title = safeDisplay(title);
  location = safeDisplay(location);
  if (!title || title.length > 500 || location.length > 500 || Date.parse(end) <= Date.parse(start))
    throw new Error("Invalid appointment fields or duration.");
  const id = data["data-event-id"];
  return { ...(id && /^[A-Za-z0-9_\-:.]{1,256}$/.test(id) ? { sourceId: id } : {}),
    title, start, end, location, allDay };
}
export function extractVisibleEvents(root = document) {
  const candidates = enumerateCandidates(root);
  const events = [];
  const failures = [];
  const seen = new Set();
  for (const el of candidates) {
    try {
      const event = parseCandidate(candidateMetadata(el));
      const identity = JSON.stringify([event.title, event.start, event.end, event.location, event.allDay]);
      if (!seen.has(identity)) { seen.add(identity); events.push(event); }
    } catch (error) { failures.push(error.message); }
  }
  if (failures.length) throw new Error(failures.length + " appointment candidates could not be parsed. Use Diagnostics; no snapshot was uploaded.");
  return events.sort((a, b) => a.start.localeCompare(b.start));
}
export const extractCalendarEvents = extractVisibleEvents;

export function getVisibleDateRange(root = document) {
  const ranges = [...root.querySelectorAll("[data-window-start][data-window-end]")].filter(visible);
  if (ranges.length === 1) return {
    windowStart: strictTimestamp(ranges[0].getAttribute("data-window-start")),
    windowEnd: strictTimestamp(ranges[0].getAttribute("data-window-end"))
  };
  // Read only the month-cell timestamp prefix, never the trailing calendar identifier.
  const cells = [...root.querySelectorAll('[id^="monthDayCell_"]')].filter(visible);
  if (cells.length) {
    const dates = cells.map(el => /^monthDayCell_(\d{4}-\d{2}-\d{2}T00:00:00(?:\.000)?(?:Z|[+-]\d{2}:\d{2}))_/.exec(el.id)?.[1]);
    if (dates.some(value => !value)) return null;
    const days = dates.map(value => {
      const utc = strictTimestamp(value);
      const local = localDate(dateParts(value.slice(0, 10)));
      if (+local !== Date.parse(utc)) throw new Error("Outlook's calendar timezone differs from this browser. Match the timezones before syncing.");
      return local;
    });
    const count = new Set(days.map(Number)).size;
    return [28, 35, 42].includes(count) ? contiguousRange(days) : null;
  }
  const days = [...root.querySelectorAll('[role="columnheader"][aria-label], [role="columnheader"][data-date]')]
    .filter(visible).map(el => dateParts(el.getAttribute("data-date") || el.getAttribute("aria-label") || ""))
    .filter(Boolean).map(parts => localDate(parts));
  return contiguousRange(days);
}
function contiguousRange(days) {
  const unique = [...new Set(days.map(Number))].sort((a, b) => a - b);
  if (!unique.length || unique.length > 42) return null;
  for (let i = 1; i < unique.length; i++) {
    const next = new Date(unique[i - 1]); next.setDate(next.getDate() + 1);
    if (+next !== unique[i]) return null;
  }
  const end = new Date(unique.at(-1)); end.setDate(end.getDate() + 1);
  return { windowStart: new Date(unique[0]).toISOString(), windowEnd: end.toISOString() };
}
function navigatePeriod(direction, root = document) {
  const names = direction === "next" ? /^(?:Next|Next (?:week|month|day|period))$/i :
    /^(?:Previous|Previous (?:week|month|day|period))$/i;
  const matches = [...root.querySelectorAll('button, [role="button"]')]
    .filter(visible).filter(el => names.test(el.getAttribute("aria-label") || el.getAttribute("title") || el.innerText));
  if (matches.length !== 1) throw new Error("Cannot uniquely identify calendar navigation. Navigate manually.");
  matches[0].click();
}
export const goToNextPeriod = root => navigatePeriod("next", root);
export const goToPreviousPeriod = root => navigatePeriod("previous", root);
