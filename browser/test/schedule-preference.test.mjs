import test from "node:test";
import assert from "node:assert/strict";
import { loadInterval, saveInterval, schedulePreferenceKey } from "../src/schedule-preference.js";
test("Preference persists independently for each service and calendar", () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  const key = schedulePreferenceKey("https://bridge.test", "test");
  assert.equal(loadInterval(storage, key), null);
  saveInterval(storage, key, 7);
  assert.equal(loadInterval(storage, key), 7);
  assert.equal(loadInterval(storage, schedulePreferenceKey("https://bridge.test", "other")), null);
  assert.equal(loadInterval(storage, schedulePreferenceKey("https://other.test", "test")), null);
  for (const value of ["broken", "0", "1.5", "10081"]) {
    data.set(key, value); assert.equal(loadInterval(storage, key), null);
  }
});
test("Blocked storage reports failure instead of pretending the choice was saved", () => {
  const storage = { setItem() { throw new Error("Blocked"); } };
  assert.throws(() => saveInterval(storage, "test", 15), /Blocked/);
});
