import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";

import { buildBrowserScript, bookmarkletUrl } from "../build-utils.mjs";
import { parseHTML } from "linkedom";

const script = await buildBrowserScript({ base: "https://loader.test", calendarName: "work-laptop", entry: "remote-loader.js" });
const favourite = new URL(bookmarkletUrl(script)).href;
const code = decodeURIComponent(favourite.slice("javascript:".length));
function setup(blockAssignment = false) {
  const { document, window } = parseHTML("<html><body></body></html>");
  const original = window.HTMLElement.prototype.attachShadow;
  window.HTMLElement.prototype.attachShadow = function () { return original.call(this, { mode: "open" }); };
  let script;
  const createElement = document.createElement.bind(document);
  document.createElement = name => {
    const element = createElement(name);
    if (name === "script") {
      script = element;
      if (blockAssignment) Object.defineProperty(element, "src", { set() { throw new TypeError("TrustedScriptURL required"); } });
    }
    return element;
  };
  const timers = new Map();
  const context = {
    document, URL, Date,
    location: { protocol: "https:", hostname: "outlook.office.com", pathname: "/calendar/view/month" },
    setTimeout: callback => { const id = timers.size + 1; timers.set(id, callback); return id; },
    clearTimeout: id => timers.delete(id)
  };
  assert.doesNotThrow(() => runInNewContext(code, context));
  const host = document.getElementById("calendar-bridge-overlay");
  const text = () => host.shadowRoot.querySelector("section").textContent;
  return { document, script, timers, host, text };
}
test("Remote Favourite shows immediate progress before download", () => {
  const { script, text, timers } = setup();
  assert.match(text(), /Loading Calendar Bridge/);
  assert.match(script.src, /^https:\/\/loader.test\/bookmark\/calendar-harvester.js\?calendar=work-laptop&v=/);
  assert.equal(timers.size, 1);
});
test("Trusted Types script URL rejection is visible instead of silent", () => {
  const { text, timers } = setup(true);
  assert.match(text(), /could not start/);
  assert.match(text(), /TrustedScriptURL required/);
  assert.match(text(), /bookmarklet.txt/);
  assert.equal(timers.size, 0);
});
test("Blocked script reports an error and clears its timer", () => {
  const { script, text, timers } = setup();
  script.onerror();
  assert.match(text(), /blocked or could not be downloaded/);
  assert.equal(timers.size, 0);
  assert.equal(script.isConnected, false);
});
test("A stalled download times out visibly", () => {
  const { text, timers } = setup();
  [...timers.values()][0]();
  assert.match(text(), /timed out after 15 seconds/);
  assert.equal(timers.size, 0);
});
test("A download that never opens the harvester reports startup failure", () => {
  const { script, text } = setup();
  script.onload();
  assert.match(text(), /downloaded, but its status notification did not open/);
});
test("Successful script startup leaves the harvester overlay open", () => {
  const { document, host, script, timers } = setup();
  host.remove();
  const harvester = document.createElement("div");
  harvester.id = "calendar-bridge-overlay";
  document.documentElement.append(harvester);
  script.onload();
  assert.equal(document.getElementById("calendar-bridge-overlay"), harvester);
  assert.equal(timers.size, 0);
});
