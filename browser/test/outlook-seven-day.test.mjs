import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { getVisibleDateRange, extractVisibleEvents } from "../src/outlook-extractor.js";
import { createTodayFollower } from "../src/follow-today.js";
process.env.TZ = "Europe/London";
function fixture(first = "2026-09-29") {
  const { document, window } = parseHTML(`<html><body>
    <table role="grid"><tr><td aria-selected="true"><button aria-label="1, January, 2020"></button></td></tr></table>
    <div data-app-section="CalendarSurfaceNavigationToolbar"><button aria-label="Go to today &#10;September 29, 2026">Today</button></div>
    <div data-app-section="Surface_Day"><div data-app-section="calendar-view-header-0"></div>
    <div data-app-section="calendar-view-0"></div></div></body></html>`);
  window.HTMLElement.prototype.getClientRects = () => [{}];
  setDates(document, first);
  return document;
}
function setDates(doc, first) {
  const header = doc.querySelector('[data-app-section="calendar-view-header-0"]');
  header.replaceChildren();
  for (let i = 0; i < 7; i++) {
    const d = new Date(first + "T12:00:00"); d.setDate(d.getDate() + i);
    const col = doc.createElement("div");
    col.setAttribute("data-column-date", `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
    header.append(col);
  }
}
test("Actual seven-day column structure defines the full window across a month boundary", () => {
  const doc = fixture();
  assert.deepEqual(getVisibleDateRange(doc), { windowStart: "2026-09-28T23:00:00.000Z", windowEnd: "2026-10-05T23:00:00.000Z" });
  const card = doc.createElement("div"); card.setAttribute("role", "button");
  card.setAttribute("aria-label", "Exam icon, Example, 10:00 to 10:30, Tuesday, September 29, 2026, Busy");
  card.setAttribute("title", "Example\n10:00 to 10:30");
  doc.querySelector('[data-app-section="calendar-view-0"]').append(card);
  assert.equal(extractVisibleEvents(doc)[0].start, "2026-09-29T09:00:00.000Z");
});
test("Incomplete, invalid and non-contiguous seven-day headers never define a replacement window", () => {
  for (const mode of ["missing", "invalid", "gap"]) {
    const doc = fixture(), cols = doc.querySelectorAll('[data-column-date]');
    if (mode === "missing") cols[6].remove();
    else cols[6].setAttribute("data-column-date", mode === "invalid" ? "unknown" : "2026-10-07");
    assert.equal(getVisibleDateRange(doc), null);
  }
});
test("Seven-day ranges preserve local midnights across a DST boundary", () => {
  assert.deepEqual(getVisibleDateRange(fixture("2026-10-23")), {
    windowStart: "2026-10-22T23:00:00.000Z", windowEnd: "2026-10-30T00:00:00.000Z" });
});
test("Returns to today once each day, waits for loading, and follows the next day after sleep", async () => {
  const doc = fixture("2026-09-15"); let current = new Date("2026-09-29T08:00:00+01:00"), clicks = 0, waits = 0;
  const surface = doc.querySelector('[data-app-section="Surface_Day"]');
  doc.querySelector('[aria-label^="Go to today"]').onclick = () => { clicks++; surface.setAttribute("aria-busy", "true"); };
  const follow = createTodayFollower({ now: () => current, wait: async () => {
    waits++;
    if (waits % 3 === 0) { setDates(doc, current.getDate() === 29 ? "2026-09-29" : "2026-09-30"); surface.removeAttribute("aria-busy"); }
  } });
  await follow(doc); assert.equal(clicks, 1); assert.ok(waits >= 7);
  await follow(doc); assert.equal(clicks, 1);
  current = new Date("2026-09-30T08:00:00+01:00");
  await follow(doc); assert.equal(clicks, 2);
});
test("Unsuccessful navigation blocks capture and retries next time", async () => {
  const doc = fixture("2026-09-15"); let clicks = 0;
  doc.querySelector('[aria-label^="Go to today"]').onclick = () => { clicks++; };
  const follow = createTodayFollower({ now: () => new Date("2026-09-29T08:00:00+01:00"), wait: async () => {}, timeoutMs: 2000 });
  await assert.rejects(follow(doc), /has not settled/);
  await assert.rejects(follow(doc), /has not settled/);
  assert.equal(clicks, 2);
});
test("Month view is left alone and ambiguous Today controls fail visibly", async () => {
  const follow = createTodayFollower({ wait: async () => {} });
  const doc = fixture(); doc.querySelector('[data-app-section="Surface_Day"]').remove();
  await follow(doc);
  const week = fixture(), toolbar = week.querySelector('[data-app-section="CalendarSurfaceNavigationToolbar"]');
  toolbar.append(toolbar.firstElementChild.cloneNode(true));
  await assert.rejects(follow(week), /Cannot identify/);
});
