import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
const favourite = (await readFile(new URL("../favourites/ONS.txt", import.meta.url), "utf8")).trim();
const script = decodeURIComponent(favourite.slice("javascript:".length));
function setup(reply) {
  const { document, window } = parseHTML("<html><body></body></html>");
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function () { return attach.call(this, {mode:"open"}); };
  let prompts = 0, alerts = 0;
  const context = { document, URL, Date, Intl, setTimeout, clearTimeout,
    location: {protocol:"https:",hostname:"outlook.cloud.microsoft",pathname:"/calendar/view/day"},
    localStorage: {getItem:()=>null}, prompt:()=>{prompts++;return reply;}, alert:()=>{alerts++;} };
  return {context, document, prompts:()=>prompts, alerts:()=>alerts};
}
test("ONS Favourite cancels without starting or caching a key", () => {
  const h=setup(null); runInNewContext(script,h.context);
  assert.equal(h.context.CalendarBridge,undefined);
  assert.equal(h.context.CalendarBridgeFavouriteUploadKeys,undefined);
});
test("ONS Favourite rejects an invalid upload key before starting", () => {
  const h=setup("invalid"); runInNewContext(script,h.context);
  assert.equal(h.alerts(),1); assert.equal(h.context.CalendarBridge,undefined);
});
test("ONS Favourite requests a key once per page, then offers the ons interval setup", () => {
  const h=setup("k".repeat(40));
  runInNewContext(script,h.context,{codeGeneration:{strings:false,wasm:false}});
  assert.equal(h.prompts(),1);
  const panel=()=>h.document.getElementById("calendar-bridge-overlay").shadowRoot;
  assert.match(panel().querySelector("section").textContent,/calendar ons sync/);
  assert.equal(panel().querySelector('input').type,"number");
  runInNewContext(script,h.context,{codeGeneration:{strings:false,wasm:false}});
  assert.equal(h.prompts(),1);
  assert.match(panel().querySelector("section").textContent,/calendar ons sync/);
  assert.equal(h.context.CalendarBridge.scheduleStatus().enabled,false);
});
