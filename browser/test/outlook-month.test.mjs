import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { parseCandidate, extractVisibleEvents, getVisibleDateRange } from "../src/outlook-extractor.js";
import { createUi } from "../src/ui.js";

process.env.TZ = "Europe/London";
const workshop = {
  title: "SafeGolf Online Workshop #5\n15:30 to 17:00",
  aria: "SafeGolf Online Workshop #5, 15:30 to 17:00, Thursday, September 17, 2026, By Example Organizer, Tentative",
  data: {}
};
function dom(html = "") {
  const { document, window } = parseHTML("<html><body>" + html + "</body></html>");
  window.HTMLElement.prototype.getClientRects = () => [{}];
  return document;
}
function month(first, count) {
  const doc = dom();
  for (let i = 0; i < count; i++) {
    const day = new Date(first); day.setDate(day.getDate() + i);
    const date = [day.getFullYear(), String(day.getMonth() + 1).padStart(2, "0"), String(day.getDate()).padStart(2, "0")].join("-");
    const offset = day.getTimezoneOffset() === -60 ? "+01:00" : "+00:00";
    const cell = doc.createElement("div");
    cell.id = "monthDayCell_" + date + "T00:00:00.000" + offset + "_GMT Standard Time_REDACTED";
    doc.body.append(cell);
  }
  return doc;
}
test("Supplied Outlook month card extracts the exact subject and BST times without organizer/status", () => {
  const doc = dom('<div data-itemindex="2" data-calitemid="REDACTED"><div role="button">' +
    '<div><time>15:30</time><span>SafeGolf Online Workshop #5</span></div></div></div>');
  const card = doc.querySelector('[role="button"]');
  card.setAttribute("title", workshop.title);
  card.setAttribute("aria-label", workshop.aria);
  assert.deepEqual(extractVisibleEvents(doc), [{
    title: "SafeGolf Online Workshop #5", start: "2026-09-17T14:30:00.000Z",
    end: "2026-09-17T16:00:00.000Z", location: "", allDay: false
  }]);
});
test("Tooltip isolates a management meeting subject from Meeting icon accessibility decoration", () => {
  const event = parseCandidate({ title: "Management Meeting\r\n10:00 to 11:00",
    aria: "Meeting icon, Management Meeting, 10:00 to 11:00, Monday, September 28, 2026, By Example, Busy",
    data: {} });
  assert.equal(event.title, "Management Meeting");
  assert.equal(event.start, "2026-09-28T09:00:00.000Z");
});
test("Three-line tooltip exposes location only when confirmed by ARIA; commas in titles survive", () => {
  const meta = { title: "Planning, Q4\nRoom 102\n1:05 PM to 2:15 PM",
    aria: "Planning, Q4, 1:05 PM to 2:15 PM, Tuesday, September 29, 2026, Room 102, By Example, Tentative", data: {} };
  assert.equal(parseCandidate(meta).title, "Planning, Q4");
  assert.equal(parseCandidate(meta).location, "Room 102");
  assert.equal(parseCandidate({ ...meta, title: meta.title.replace("Room 102", "Private notes") }).location, "");
});
test("Conflicting tooltip subject or times fail closed", () => {
  assert.throws(() => parseCandidate({ ...workshop, title: workshop.title.replace("17:00", "18:00") }), /times disagree/);
  assert.throws(() => parseCandidate({ ...workshop, title: workshop.title.replace("#5", "#6") }), /subjects disagree/);
});
test("Monday-first month includes the previous and next month's visible days", () => {
  assert.deepEqual(getVisibleDateRange(month("2026-08-31T00:00:00+01:00", 35)), {
    windowStart: "2026-08-30T23:00:00.000Z", windowEnd: "2026-10-04T23:00:00.000Z"
  });
});
test("Sunday-first view follows actual cells rather than assuming the week starts Monday", () => {
  assert.deepEqual(getVisibleDateRange(month("2026-08-30T00:00:00+01:00", 35)), {
    windowStart: "2026-08-29T23:00:00.000Z", windowEnd: "2026-10-03T23:00:00.000Z"
  });
});
test("Month range crosses the daylight-saving boundary using each cell's offset", () => {
  assert.deepEqual(getVisibleDateRange(month("2026-09-28T00:00:00+01:00", 35)), {
    windowStart: "2026-09-27T23:00:00.000Z", windowEnd: "2026-11-02T00:00:00.000Z"
  });
});
test("Partial, malformed and gapped month cells do not provide an authoritative window", () => {
  assert.equal(getVisibleDateRange(month("2026-08-31T00:00:00+01:00", 27)), null);
  const missing = month("2026-08-31T00:00:00+01:00", 36);
  missing.body.children[10].remove();
  assert.equal(getVisibleDateRange(missing), null);
  const malformed = month("2026-08-31T00:00:00+01:00", 35);
  malformed.body.firstElementChild.id = "monthDayCell_unknown";
  assert.equal(getVisibleDateRange(malformed), null);
});
test("A month-cell timezone inconsistent with the parser fails closed", () => {
  const doc = month("2026-08-31T00:00:00+01:00", 35);
  const cell = doc.body.firstElementChild;
  cell.id = cell.id.replace("+01:00", "+00:00");
  assert.throws(() => getVisibleDateRange(doc), /timezone differs/);
});
test("Review displays local times and isolated subjects, with raw UTC JSON collapsed", () => {
  const doc = dom(); globalThis.document = doc;
  const attach = doc.defaultView.HTMLElement.prototype.attachShadow;
  doc.defaultView.HTMLElement.prototype.attachShadow = function () { return attach.call(this, { mode: "open" }); };
  try {
    const ui = createUi();
    ui.showEvents([parseCandidate(workshop)], "Europe/London");
    const root = ui.host.shadowRoot;
    const item = root.querySelector("li").textContent;
    assert.match(item, /Thu, 17 Sept 2026, 15:30 – 17:00/);
    assert.match(item, /Location not available/);
    assert.doesNotMatch(item, /Organizer|Tentative/);
    assert.equal(root.querySelector("details").hasAttribute("open"), false);
    assert.match(root.querySelector("textarea").value, /14:30:00.000Z/);
  } finally { delete globalThis.document; }
});