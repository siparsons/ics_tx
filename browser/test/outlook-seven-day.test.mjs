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

function shorterView(first, count, heading) {
  const doc = fixture(first);
  [...doc.querySelectorAll('[data-column-date]')].slice(count).forEach(el => el.remove());
  const title = doc.createElement("button");
  title.setAttribute("aria-label", heading + ", Jump to a specific date or date range.");
  doc.querySelector('[data-app-section="CalendarSurfaceNavigationToolbar"]').append(title);
  return doc;
}

test("Complete four-day view matching the heading settles on today", async () => {
  const doc = shorterView("2026-10-12", 4, "October 12\u201315, 2026");
  assert.deepEqual(getVisibleDateRange(doc), {windowStart:"2026-10-11T23:00:00.000Z",windowEnd:"2026-10-15T23:00:00.000Z"});
  const follow = createTodayFollower({now:()=>new Date("2026-10-12T10:00:00+01:00"),wait:async()=>{}});
  await follow(doc);
});

test("Short day/week views require matching headings and preserve DST and year boundaries", () => {
  const cases = [
    ["2026-10-12",1,"October 12, 2026","2026-10-12T23:00:00.000Z"],
    ["2026-10-12",5,"2026, October 12 - 16","2026-10-16T23:00:00.000Z"],
    ["2026-10-23",4,"October 23 - 26, 2026","2026-10-27T00:00:00.000Z"],
    ["2026-09-29",4,"2026, September 29 - October 02","2026-10-02T23:00:00.000Z"],
    ["2026-12-30",4,"2026, December 30 - January 02","2027-01-03T00:00:00.000Z"],
    ["2026-12-30",4,"December 30 - January 2, 2027","2027-01-03T00:00:00.000Z"]
  ];
  for(const [first,count,heading,end] of cases) assert.equal(getVisibleDateRange(shorterView(first,count,heading))?.windowEnd,end,heading);
});

test("Partial and stale columns cannot masquerade as a complete short view", () => {
  for(const [count,heading] of [[4,"October 12 - 18, 2026"],[3,"October 12 - 15, 2026"],[4,"October 13 - 16, 2026"],[7,"October 12 - 15, 2026"],[4,"Unknown range"]]) {
    assert.equal(getVisibleDateRange(shorterView("2026-10-12",count,heading)),null);
  }
  const doc=shorterView("2026-10-12",4,"October 12 - 15, 2026");
  doc.querySelectorAll('[data-column-date]')[2].setAttribute('data-column-date','2026-10-19');
  assert.equal(getVisibleDateRange(doc),null);
});
