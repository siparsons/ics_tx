import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { parseHTML } from "linkedom";
import { encryptCalendarPayload } from "../src/crypto.js";
import { uploadCalendar } from "../src/uploader.js";
import { parseCandidate, strictTimestamp, extractVisibleEvents, getVisibleDateRange, diagnostics, assertOutlook } from "../src/outlook-extractor.js";

const pair = await webcrypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 4096,
  publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["encrypt", "decrypt"]);
const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
const payload = { version: 1, events: [{ title: "Confidential café 😊", start: "2026-09-29T10:00:00Z" }] };
function bytes(s) { return Buffer.from(s, "base64url"); }
async function decrypt(envelope) {
  const raw = await webcrypto.subtle.decrypt({ name: "RSA-OAEP" }, pair.privateKey, bytes(envelope.wrappedKey));
  const key = await webcrypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["decrypt"]);
  const clear = await webcrypto.subtle.decrypt({ name: "AES-GCM", iv: bytes(envelope.iv),
    additionalData: new TextEncoder().encode("calendar-bridge-v1"), tagLength: 128 }, key, bytes(envelope.ciphertext));
  return JSON.parse(new TextDecoder().decode(clear));
}
test("Web Crypto envelope roundtrips Unicode; fresh key and nonce on each upload", async () => {
  const a = await encryptCalendarPayload(payload, jwk, "primary", webcrypto);
  const b = await encryptCalendarPayload(payload, jwk, "primary", webcrypto);
  assert.deepEqual(await decrypt(a), payload);
  assert.notEqual(a.iv, b.iv); assert.notEqual(a.wrappedKey, b.wrappedKey);
  assert.equal(bytes(a.iv).length, 12);
  assert.deepEqual(Object.keys(a).sort(), ["ciphertext", "iv", "keyId", "version", "wrappedKey"]);
  const corrupted = bytes(a.ciphertext); corrupted[0] ^= 1;
  await assert.rejects(decrypt({ ...a, ciphertext: corrupted.toString("base64url") }));
});
test("Uploader posts only ciphertext, never plaintext, with no cookies or redirects", async () => {
  const calls = [];
  const mock = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, json: async () => options.method === "GET" ? { keyId: "primary", algorithm: "RSA-OAEP-256", jwk } : { eventCount: 1 } };
  };
  await uploadCalendar(payload, { API_BASE_URL: "https://bridge.test", API_KEY: "a".repeat(40) }, mock, webcrypto);
  const post = calls.find(call => call.options.method === "POST");
  assert.equal(calls.length, 2);
  assert.equal(post.options.credentials, "omit");
  assert.equal(post.options.redirect, "error");
  assert.equal(post.options.headers["X-API-Key"], "a".repeat(40));
  assert.ok(!post.options.body.includes("Confidential"));
  assert.deepEqual(await decrypt(JSON.parse(post.options.body)), { ...payload, calendarName: "default" });
  assert.equal(post.url, "https://bridge.test/api/v1/calendar/sync?calendar=default");
});
test("Encryption failure never falls back to a plaintext POST", async () => {
  const calls = [];
  await assert.rejects(uploadCalendar(payload, { API_BASE_URL: "https://failed.test", API_KEY: "b".repeat(40) },
    async (url, options) => { calls.push(options.method); return { ok: true, json: async () =>
      ({ keyId: "primary", algorithm: "RSA-OAEP-256", jwk: { kty: "RSA", n: "bad", e: "bad" } }) }; }, webcrypto));
  assert.deepEqual(calls, ["GET"]);
});
test("HTTP endpoints are refused before network calls", async () => {
  await assert.rejects(uploadCalendar(payload, { API_BASE_URL: "http://bridge.test", API_KEY: "a".repeat(40) },
    () => assert.fail("must not fetch")), /HTTPS/);
});
const meta = { aria: "", title: "", text: "Private meeting body is never used", data: {
  "data-subject": "Review", "data-start": "2026-09-29T10:00:00+01:00", "data-end": "2026-09-29T11:00:00+01:00",
  "data-location": "Room https://teams.example/join person@example.com", "data-event-id": "event-123"
} };
test("Structured metadata extracts only allowed fields and strips URLs and addresses", () => {
  assert.deepEqual(parseCandidate(meta), { sourceId: "event-123", title: "Review", start: "2026-09-29T09:00:00.000Z",
    end: "2026-09-29T10:00:00.000Z", location: "Room", allDay: false });
});
test("Supported English accessibility labels parse separately from DOM", () => {
  const value = parseCandidate({ aria: "Planning, 10:00 AM to 11:00 AM, Tuesday, 29 September 2026, Location: Room",
    data: {}, dateContext: "" });
  assert.equal(value.title, "Planning"); assert.equal(value.location, "Room");
  assert.equal(new Date(value.start).getHours(), 10);
});
test("Ambiguous, unsupported and rollover timestamps fail closed", () => {
  assert.throws(() => strictTimestamp("2026-02-30T10:00:00Z"));
  assert.throws(() => strictTimestamp("2026-09-29T10:00:00"));
  assert.throws(() => parseCandidate({ aria: "Planning, 10:00 to 11:00", data: {} }));
  assert.throws(() => parseCandidate({ aria: "Planning, 10:00 to 11:00 AM, 29 September 2026", data: {} }));
  assert.throws(() => parseCandidate({ ...meta, data: { ...meta.data, "data-subject": "" } }));
});
function dom(html) {
  const { document, window } = parseHTML("<html><body>" + html + "</body></html>");
  window.HTMLElement.prototype.getClientRects = function () { return [{}]; };
  return document;
}
test("DOM enumeration deduplicates nested cards, excludes hidden elements, and reports parse failures", () => {
  const doc = dom('<div data-window-start="2026-09-29T00:00:00Z" data-window-end="2026-09-30T00:00:00Z">' +
    '<div data-subject="Planning" data-start="2026-09-29T10:00:00Z" data-end="2026-09-29T11:00:00Z">' +
    '<span role="button" aria-label="Planning, 10:00 to 11:00"></span></div>' +
    '<div hidden data-event-id="hidden"></div></div>');
  assert.equal(extractVisibleEvents(doc).length, 1);
  assert.equal(diagnostics(doc).length, 1);
  assert.equal(getVisibleDateRange(doc).windowStart, "2026-09-29T00:00:00.000Z");
  const bad = doc.createElement("div"); bad.setAttribute("data-event-id", "unknown"); doc.body.append(bad);
  assert.throws(() => extractVisibleEvents(doc), /no snapshot was uploaded/);
});
test("Only Outlook calendar origins may run the harvester", () => {
  assertOutlook({ protocol: "https:", hostname: "outlook.office.com", pathname: "/calendar/view/week" });
  assert.throws(() => assertOutlook({ protocol: "https:", hostname: "outlook.office.com.evil.test", pathname: "/calendar" }));
  assert.throws(() => assertOutlook({ protocol: "https:", hostname: "outlook.office.com", pathname: "/mail" }));
});

test("Built bookmarklet displays review UI and encrypts its named-calendar upload", async () => {
  const { build } = await import("esbuild");
  const { runInNewContext } = await import("node:vm");
  const { fileURLToPath } = await import("node:url");
  const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/calendar-harvester.js", import.meta.url))],
    bundle: true, write: false, format: "iife", define: {
      __API_BASE_URL__: JSON.stringify("https://ui-bridge.test"),
      __API_KEY__: JSON.stringify(""),
      __CALENDAR_NAME__: JSON.stringify("work-laptop")
    } });
  const doc = dom('<div data-window-start="2026-09-29T00:00:00Z" data-window-end="2026-09-30T00:00:00Z">' +
    '<div data-subject="Private review title" data-start="2026-09-29T10:00:00Z" data-end="2026-09-29T11:00:00Z"></div></div>');
  const originalShadow = doc.defaultView.HTMLElement.prototype.attachShadow;
  doc.defaultView.HTMLElement.prototype.attachShadow = function () { return originalShadow.call(this, { mode: "open" }); };
  const requests = [];
  const context = { document: doc, location: { protocol: "https:", hostname: "outlook.office.com", pathname: "/calendar/view/month" },
    crypto: webcrypto, URL, Intl, Date, TextEncoder, Uint8Array, btoa, setTimeout, clearTimeout, AbortController,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, json: async () => options.method === "GET" ?
        { keyId: "primary", algorithm: "RSA-OAEP-256", jwk } : { eventCount: 1 } };
    } };
  runInNewContext(bundled.outputFiles[0].text, context);
  const panel = doc.getElementById("calendar-bridge-overlay").shadowRoot;
  assert.ok(panel.querySelector("section").textContent.includes("Found 1 events"));
  const inputs = [...panel.querySelectorAll("input")];
  inputs.find(input => input.type === "password").value = "k".repeat(40);
  inputs.find(input => input.type === "checkbox").checked = true;
  const upload = [...panel.querySelectorAll("button")].find(button => button.textContent === "Encrypt and sync");
  await upload.onclick();
  assert.ok(panel.querySelector("section").textContent.includes("1 events synced"));
  const post = requests.find(request => request.options.method === "POST");
  assert.equal(post.url, "https://ui-bridge.test/api/v1/calendar/sync?calendar=work-laptop");
  assert.ok(!post.options.body.includes("Private review title"));
  const decrypted = await decrypt(JSON.parse(post.options.body));
  assert.equal(decrypted.calendarName, "work-laptop");
  assert.equal(decrypted.events[0].title, "Private review title");
  assert.equal(decrypted.events.length, 1);
});

test("Calendar toolbar actions are not treated as appointment candidates", () => {
  const doc = dom('<button role="button" aria-label="New meeting"></button>' +
    '<button role="button" aria-label="Schedule appointment"></button>' +
    '<div role="gridcell" aria-label="All day"></div>');
  assert.equal(diagnostics(doc).length, 0);
  assert.equal(extractVisibleEvents(doc).length, 0);
});
