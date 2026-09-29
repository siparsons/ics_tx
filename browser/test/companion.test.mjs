import test from "node:test";
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { webcrypto } from "node:crypto";
import { installCompanion } from "../src/companion.js";
import { openCompanion } from "../src/companion-client.js";

const channel = "a".repeat(32), origin = "https://outlook.office.com";
const envelope = JSON.stringify({ version: 1, keyId: "primary", wrappedKey: "abc", iv: "def", ciphertext: "ghi" });
function harness(responseStatus = 200, origin = "https://outlook.office.com") {
  let listener;
  const calls = [], replies = [];
  const { document } = parseHTML('<html><body><p id="status"></p><p id="history-empty">No uploads yet.</p><ol id="history"></ol></body></html>');
  const opener = { postMessage: (data, target) => replies.push({ data, target }) };
  const win = { opener, location: new URL("https://bridge.test/bookmark/companion.html#channel=" + channel + "&origin=" + encodeURIComponent(origin)),
    addEventListener: (name, handler) => { listener = handler; }, removeEventListener: () => {} };
  const cleanup = installCompanion(win, document, async (url, options) => {
    calls.push({ url, options }); return { ok: responseStatus === 200, status: responseStatus, json: async () => ({ eventCount: 2 }) };
  });
  return { calls, replies, opener, cleanup, win, document,
    send: (data, overrides = {}) => listener({ origin, source: opener, data: { channel, ...data }, ...overrides }) };
}
const upload = { type: "calendar-bridge:request", id: "request-1", method: "POST",
  path: "/api/v1/calendar/sync?calendar=work-laptop", apiKey: "k".repeat(40), body: envelope };

test("Companion rejects messages from unrelated origins, windows or channels", async () => {
  const h = harness();
  await h.send(upload, { origin: "https://evil.test" });
  await h.send(upload, { source: {} });
  await h.send({ ...upload, channel: "b".repeat(32) });
  assert.equal(h.calls.length, 0); assert.equal(h.replies.length, 0); h.cleanup();
});
test("Companion permits only fixed endpoints and encrypted envelopes", async () => {
  for (const patch of [
    { body: JSON.stringify({ events: [{ title: "Private" }] }) },
    { path: "https://evil.test/steal" }, { path: "/api/v1/admin" },
    { method: "GET", path: "/api/v1/crypto/public-key" },
    { body: envelope.slice(0, -1) }, { apiKey: "" },
    { body: JSON.stringify({ ...JSON.parse(envelope), title: "Private" }) }
  ]) {
    const h = harness(); await h.send({ ...upload, ...patch });
    assert.equal(h.calls.length, 0); assert.equal(h.replies[0].data.status, 400); h.cleanup();
  }
});
test("Companion posts ciphertext once with credentials omitted and an exact reply origin", async () => {
  const h = harness(); await h.send(upload); await h.send(upload);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, "https://bridge.test/api/v1/calendar/sync?calendar=work-laptop");
  assert.equal(h.calls[0].options.body, envelope);
  assert.equal(h.calls[0].options.credentials, "omit");
  assert.equal(h.calls[0].options.redirect, "error");
  assert.equal(h.replies[0].target, origin); h.cleanup();
});
test("Popup blocking is reported without starting a network request", () => {
  assert.throws(() => openCompanion("https://bridge.test", { crypto: webcrypto, location: { origin }, open: () => null }), /blocked.*companion tab/);
});
test("Client ignores forged readiness/responses and only sends to the companion origin", async () => {
  let listener; const outgoing = [];
  const popup = { closed: false, postMessage: (data, target) => outgoing.push({ data, target }) };
  const client = openCompanion("https://bridge.test", {
    crypto: webcrypto, location: { origin }, open: () => popup,
    addEventListener: (name, fn) => { listener = fn; }, removeEventListener: () => {}
  });
  const abort = new AbortController();
  const pending = client.fetch("https://bridge.test/api/v1/crypto/public-key", { method: "GET", signal: abort.signal });
  const nonce = outgoing[0].data.channel;
  listener({ source: {}, origin: "https://bridge.test", data: { type: "calendar-bridge:ready", channel: nonce } });
  listener({ source: popup, origin: "https://evil.test", data: { type: "calendar-bridge:ready", channel: nonce } });
  assert.equal(outgoing.some(message => message.data.type === "calendar-bridge:request"), false);
  listener({ source: popup, origin: "https://bridge.test", data: { type: "calendar-bridge:ready", channel: nonce } });
  const request = outgoing.find(message => message.data.type === "calendar-bridge:request").data;
  listener({ source: popup, origin: "https://bridge.test",
    data: { type: "calendar-bridge:response", channel: nonce, id: request.id, status: 200, result: { keyId: "primary" } } });
  assert.equal((await (await pending).json()).keyId, "primary");
  assert.ok(outgoing.every(message => message.target === "https://bridge.test")); client.dispose();
});
test("Aborting a waiting companion request releases it without retrying a POST", async () => {
  const popup = { closed: false, postMessage() {} };
  const client = openCompanion("https://bridge.test", {
    crypto: webcrypto, location: { origin }, open: () => popup,
    addEventListener() {}, removeEventListener() {}
  });
  const abort = new AbortController();
  const pending = client.fetch("https://bridge.test/api/v1/crypto/public-key", { method: "GET", signal: abort.signal });
  abort.abort(); await assert.rejects(pending, /cancelled/); client.dispose();
});
test("History lists timestamped results newest first and never includes credentials or encrypted bodies", async () => {
  const h = harness();
  await h.send(upload);
  await h.send({ ...upload, id: "request-2", path: "/api/v1/calendar/sync?calendar=meeting-room" });
  const rows = [...h.document.querySelectorAll("#history li")];
  assert.equal(rows.length, 2);
  assert.match(rows[0].textContent, /meeting-room: 2 events synced/);
  assert.match(rows[1].textContent, /work-laptop: 2 events synced/);
  assert.ok(Number.isFinite(Date.parse(rows[0].querySelector("time").dateTime)));
  assert.equal(h.document.getElementById("history-empty"), null);
  assert.ok(!h.document.body.textContent.includes(upload.apiKey));
  assert.ok(!h.document.body.textContent.includes(envelope));
  h.cleanup();
});
test("History includes HTTP failures and retains only the latest 100 results", async () => {
  const h = harness(401);
  for (let i = 0; i < 103; i++) await h.send({ ...upload, id: "request-" + i });
  const rows = h.document.querySelectorAll("#history li");
  assert.equal(rows.length, 100);
  assert.match(rows[0].textContent, /work-laptop: failed \(HTTP 401\)/);
  assert.equal(rows[0].className, "failed");
  h.cleanup();
});


test("Companion accepts the cloud.microsoft calendar and binds replies to that exact origin", async () => {
  const cloudOrigin = "https://outlook.cloud.microsoft";
  const h = harness(200, cloudOrigin);
  await h.send({ type: "calendar-bridge:hello" });
  assert.equal(h.replies[0].data.type, "calendar-bridge:ready");
  await h.send(upload, { origin: cloudOrigin + ".evil.test" });
  await h.send(upload, { origin: "https://outlook.office.com" });
  assert.equal(h.calls.length, 0);
  await h.send(upload);
  assert.equal(h.calls.length, 1);
  assert.equal(h.replies.at(-1).data.status, 200);
  assert.ok(h.replies.every(reply => reply.target === cloudOrigin));
  h.cleanup();
});
