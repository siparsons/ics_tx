import { webcrypto } from "node:crypto";
import { uploadCalendar } from "../browser/src/uploader.js";
const start = new Date();
start.setUTCDate(start.getUTCDate() + 1); start.setUTCHours(0, 0, 0, 0);
const end = new Date(+start + 86400000);
const payload = {
  version: 1, source: "outlook-web-bookmarklet", capturedAt: new Date().toISOString(),
  windowStart: start.toISOString(), windowEnd: end.toISOString(), timezone: "UTC",
  events: [{ title: "Calendar Bridge sample", start: new Date(+start + 36000000).toISOString(),
    end: new Date(+start + 39600000).toISOString(), location: "Sample room", allDay: false }]
};
try {
  const result = await uploadCalendar(payload, { API_BASE_URL: process.env.API_BASE_URL,
    API_KEY: process.env.API_KEY, CALENDAR_NAME: process.env.CALENDAR_NAME || "sample" }, fetch, webcrypto);
  console.log("Encrypted sample imported; event count:", result.eventCount);
} catch (error) { console.error(error.message); process.exitCode = 1; }
