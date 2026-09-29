import { build } from "esbuild";
import { minify } from "terser";
import { fileURLToPath } from "node:url";

export async function buildBrowserScript({ base, calendarName, key = "", entry = "calendar-harvester.js" }) {
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("./src/" + entry, import.meta.url))],
    bundle: true, write: false, minify: false, format: "iife", target: "es2020",
    define: { __API_BASE_URL__: JSON.stringify(base), __API_KEY__: JSON.stringify(key),
      __CALENDAR_NAME__: JSON.stringify(calendarName) },
    legalComments: "none"
  });
  const result = await minify(bundled.outputFiles[0].text, {
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
