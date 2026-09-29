import { build } from "esbuild";
import { minify } from "terser";
import { fileURLToPath } from "node:url";

export async function buildBrowserScript({ base, calendarName, key = "", entry = "calendar-harvester.js", promptForKey = false }) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./src/" + entry, import.meta.url))],
    bundle: true, write: false, minify: false, format: "iife", target: "es2020",
    define: { __API_BASE_URL__: JSON.stringify(base), __API_KEY__: promptForKey ? "__calendarBridgeUploadKey" : JSON.stringify(key),
      __CALENDAR_NAME__: JSON.stringify(calendarName) },
    legalComments: "none"
  });
  let source = bundled.outputFiles[0].text;
  if (promptForKey) {
    source = `(() => {
      if (globalThis.CalendarBridge?.isRunning?.()) return;
      const origin = ${JSON.stringify(base)};
      let __calendarBridgeUploadKey = globalThis.CalendarBridgeFavouriteUploadKeys?.[origin];
      if (!__calendarBridgeUploadKey) {
        __calendarBridgeUploadKey = globalThis.prompt("Calendar Bridge: enter the upload API key. It will be remembered until this Outlook page is refreshed.");
        if (__calendarBridgeUploadKey === null) return;
        __calendarBridgeUploadKey = __calendarBridgeUploadKey.trim();
        if (!/^[A-Za-z0-9_-]{32,256}$/.test(__calendarBridgeUploadKey)) {
          globalThis.alert("Enter the upload API key (32–256 letters, numbers, underscores or hyphens).");
          return;
        }
        globalThis.CalendarBridgeFavouriteUploadKeys ??= Object.create(null);
        globalThis.CalendarBridgeFavouriteUploadKeys[origin] = __calendarBridgeUploadKey;
      }
      ${source}
    })();`;
  }
  const result = await minify(source, {
    ecma: 2020,
    compress: { passes: 3 },
    mangle: { toplevel: true },
    format: { comments: false, ascii_only: true },
    sourceMap: false
  });
  if (!result.code) throw new Error("Browser minification produced no output.");
  return result.code;
}

export function bookmarkletUrl(script) {
  // A javascript: URL is a complete URI, not one encoded URI component.
  // Percent escapes must round-trip, and # must not start a URL fragment.
  return "javascript:" + encodeURI(script).replaceAll("#", "%23");
}
