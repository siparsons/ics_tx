import test from "node:test";
import assert from "node:assert/strict";
import { createScheduler, nextSyncTime } from "../src/scheduler.js";
process.env.TZ = "Europe/London";

function harness(task = async () => {}) {
  let current = new Date("2026-09-29T08:00:00+01:00"), count = 0, id = 0;
  const timers = new Map(), documentTarget = new EventTarget(), wakeTarget = new EventTarget();
  const scheduler = createScheduler(async () => { count++; await task(); }, {
    now: () => current, setTimer: fn => { timers.set(++id, fn); return id; },
    clearTimer: id => timers.delete(id), documentTarget, wakeTarget
  });
  return { scheduler, timers, documentTarget, wakeTarget,
    setTime: value => { current = new Date(value); }, count: () => count };
}
test("Schedule selects the next local 09:00, 13:00 or 17:00 and rolls to tomorrow", () => {
  for (const [input, expected] of [
    ["08:00", "09:00"], ["09:00", "13:00"], ["13:00", "17:00"]
  ]) assert.equal(nextSyncTime(new Date("2026-09-29T" + input + ":00+01:00")).getHours(), +expected.slice(0,2));
  assert.equal(nextSyncTime(new Date("2026-09-29T17:00:00+01:00")).toISOString(), "2026-09-30T08:00:00.000Z");
});
test("Daily local schedule follows daylight-saving changes in both directions", () => {
  assert.equal(nextSyncTime(new Date("2026-10-24T18:00:00+01:00")).toISOString(), "2026-10-25T09:00:00.000Z");
  assert.equal(nextSyncTime(new Date("2026-03-28T18:00:00+00:00")).toISOString(), "2026-03-29T08:00:00.000Z");
});
test("Starts immediately and executes once at each scheduled time", async () => {
  const h = harness(); await h.scheduler.start();
  assert.equal(h.count(), 1);
  for (const hour of [9, 13, 17]) {
    h.setTime("2026-09-29T" + String(hour).padStart(2, "0") + ":00:00+01:00");
    await h.scheduler.check(); await h.scheduler.check();
  }
  assert.equal(h.count(), 4);
  assert.equal(h.timers.size, 1);
  h.scheduler.stop();
});
test("Several missed slots after sleep produce only one catch-up", async () => {
  const h = harness(); await h.scheduler.start();
  h.setTime("2026-10-01T16:00:00+01:00");
  await h.scheduler.check(); await h.scheduler.check();
  assert.equal(h.count(), 2);
  assert.equal(h.scheduler.status().nextRun, "2026-10-01T16:00:00.000Z");
  h.scheduler.stop();
});
test("Visibility and focus wakeups do not overlap a running upload", async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const start = h.scheduler.start(); release(); await start;
  h.setTime("2026-09-29T14:00:00+01:00");
  h.documentTarget.dispatchEvent(new Event("visibilitychange"));
  h.wakeTarget.dispatchEvent(new Event("focus"));
  h.wakeTarget.dispatchEvent(new Event("online"));
  assert.equal(h.count(), 2);
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.timers.size, 1); h.scheduler.stop();
});
test("Stopping removes timers and wake listeners, including during an upload", async () => {
  let release;
  const h = harness(() => new Promise(resolve => { release = resolve; }));
  const start = h.scheduler.start();
  h.scheduler.stop(); release(); await start;
  h.setTime("2026-09-30T14:00:00+01:00");
  h.wakeTarget.dispatchEvent(new Event("focus"));
  await h.scheduler.check();
  assert.equal(h.count(), 1); assert.equal(h.timers.size, 0);
  assert.equal(h.scheduler.status().enabled, false);
});
test("Restarting replaces the timer rather than stacking schedules", async () => {
  const h = harness(); await h.scheduler.start(); await h.scheduler.start();
  assert.equal(h.timers.size, 1);
  h.setTime("2026-09-29T09:00:00+01:00"); await h.scheduler.check();
  assert.equal(h.count(), 3); h.scheduler.stop();
});
test("Failed tasks wait for the next slot rather than retrying on each wake", async () => {
  const h = harness(async () => { throw new Error("Network unavailable"); });
  await h.scheduler.start();
  assert.equal(h.scheduler.status().lastError, "Network unavailable");
  await h.scheduler.check(); assert.equal(h.count(), 1);
  h.setTime("2026-09-29T09:00:00+01:00");
  await h.scheduler.check(); await h.scheduler.check();
  assert.equal(h.count(), 2); h.scheduler.stop();
});