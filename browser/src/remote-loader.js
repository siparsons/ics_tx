import { assertOutlook } from "./outlook-extractor.js";
import { createUi } from "./ui.js";

// Show progress before touching script.src: Trusted Types can throw synchronously.
export function loadRemoteHarvester(base, calendarName) {
  if (globalThis.CalendarBridge?.isRunning?.()) return;
  const ui = createUi({ notification: true });
  ui.text("Loading Calendar Bridge…");
  let script;
  let timeout;
  const cleanup = () => {
    clearTimeout(timeout);
    if (script) { script.onload = null; script.onerror = null; script.remove(); }
  };
  const fail = message => {
    cleanup();
    if (!ui.host.isConnected) return;
    ui.clear();
    ui.text("Calendar Bridge could not start");
    ui.text(message);
    ui.text("Replace this Favourite's URL with the full contents of browser/dist/bookmarklet.txt, then run it on Outlook Calendar.");
  };
  try {
    assertOutlook();
    const address = new URL(base);
    if (address.protocol !== "https:" || address.username || address.password ||
        address.pathname !== "/" || address.search || address.hash)
      throw new Error("The configured service address must be an HTTPS origin.");
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(calendarName)) throw new Error("Invalid calendar name.");
    ui.host.setAttribute("aria-live", "polite");
    script = document.createElement("script");
    script.referrerPolicy = "no-referrer";
    script.onerror = () => fail("The remote script was blocked or could not be downloaded.");
    script.onload = () => {
      // The harvester replaces this loader's overlay synchronously when it starts.
      if (ui.host.isConnected || !document.getElementById("calendar-bridge-overlay"))
        fail("The script downloaded, but its status notification did not open.");
      else cleanup();
    };
    timeout = setTimeout(() => fail("Loading timed out after 15 seconds. Check the connection or use the self-contained Favourite."), 15000);
    script.src = address.origin + "/bookmark/calendar-harvester.js?calendar=" +
      encodeURIComponent(calendarName) + "&v=" + Date.now();
    document.documentElement.append(script);
  } catch (error) {
    fail(error.message || "The browser blocked the remote loader.");
  }
}

if (typeof __API_BASE_URL__ !== "undefined") loadRemoteHarvester(__API_BASE_URL__, __CALENDAR_NAME__);
