import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import { parseHTML } from "linkedom";
const favourite = (await readFile(new URL("../favourites/ONS.txt", import.meta.url), "utf8")).trim();
const script = decodeURIComponent(favourite.slice("javascript:".length));
function setup() {
  const { document, window } = parseHTML("<html><body></body></html>");
  const attach = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function () { return attach.call(this, {mode:"open"}); };
  let prompts = 0;
  const context = { document, URL, Date, Intl, setTimeout, clearTimeout,
    crypto: {subtle:{}},
    location: {protocol:"https:",hostname:"outlook.cloud.microsoft",pathname:"/calendar/view/day"},
    localStorage: {getItem:()=>null}, prompt:()=>{prompts++;throw new Error("Unexpected key prompt");} };
  return {context, document, prompts:()=>prompts};
}

test("ONS Favourite contains one editable API-key placeholder and the correct service", () => {
  assert.equal(favourite.split("PASTE_API_KEY_HERE").length - 1, 1);
  assert.ok(favourite.startsWith("javascript:"));
  assert.ok(script.includes("https://ics-tx.onrender.com"));
  assert.ok(!script.includes("enter the upload API key"));
});

test("Unedited ONS placeholder fails without prompting or starting the timer", () => {
  const h=setup(); runInNewContext(script,h.context);
  assert.equal(h.prompts(),0);
  assert.match(h.document.getElementById("calendar-bridge-overlay").shadowRoot.querySelector("section").textContent,/This Favourite has no upload key/);
  assert.equal(h.context.CalendarBridge.scheduleStatus().enabled,false);
});

test("Manually filled ONS Favourite offers interval setup without asking for a key", () => {
  const h=setup();
  const filled=script.replace("PASTE_API_KEY_HERE", "k".repeat(40));
  runInNewContext(filled,h.context,{codeGeneration:{strings:false,wasm:false}});
  const panel=()=>h.document.getElementById("calendar-bridge-overlay").shadowRoot;
  assert.equal(h.prompts(),0);
  assert.match(panel().querySelector("section").textContent,/calendar ons sync/);
  assert.equal(panel().querySelector('input').type,"number");
  runInNewContext(filled,h.context,{codeGeneration:{strings:false,wasm:false}});
  assert.equal(h.prompts(),0);
  assert.match(panel().querySelector("section").textContent,/calendar ons sync/);
  assert.equal(h.context.CalendarBridge.scheduleStatus().enabled,false);
});
