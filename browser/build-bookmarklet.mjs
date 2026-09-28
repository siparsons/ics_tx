import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { apiOrigin } from "./src/uploader.js";

const base = apiOrigin(process.env.API_BASE_URL || "https://calendar-bridge.example.invalid");
const apiKey = process.env.API_KEY || "";
const calendarName = process.env.CALENDAR_NAME || "default";
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(calendarName)) throw new Error("Invalid CALENDAR_NAME.");
if (apiKey && !/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)) throw new Error("API_KEY must be URL-safe, 32–256 characters.");
const dir = fileURLToPath(new URL(".", import.meta.url));
async function bundle(key) {
  const result = await build({ entryPoints: [resolve(dir, "src/calendar-harvester.js")], bundle: true,
    write: false, minify: true, format: "iife", target: "es2020",
    define: { __API_BASE_URL__: JSON.stringify(base), __API_KEY__: JSON.stringify(key), __CALENDAR_NAME__: JSON.stringify(calendarName) },
    legalComments: "none" });
  return result.outputFiles[0].text.trim();
}
const publicScript = await bundle(""); // A client credential must never be published in wwwroot.
const dist = resolve(dir, "dist");
await mkdir(dist, { recursive: true });
const deployed = resolve(dir, "../src/CalendarBridge.Api/wwwroot/bookmark");
await mkdir(deployed, { recursive: true });
await writeFile(resolve(dist, "calendar-harvester.js"), publicScript + "\n");
await writeFile(resolve(deployed, "calendar-harvester.js"), publicScript + "\n");
const standalone = "javascript:" + encodeURIComponent(publicScript);
await writeFile(resolve(dist, "bookmarklet.txt"), standalone + "\n");
const loader = "(()=>{const s=document.createElement('script');s.src=" +
  JSON.stringify(base + "/bookmark/calendar-harvester.js?calendar=" + encodeURIComponent(calendarName) + "&v=") +
  "+Date.now();s.referrerPolicy='no-referrer';s.onerror=()=>{s.remove();const d=document.createElement('div');" +
  "d.style.cssText='position:fixed;top:12px;right:12px;z-index:2147483647;background:white;color:black;padding:20px;border:1px solid';" +
  "d.textContent='Calendar Bridge could not load. Try the self-contained Favourite. ';const b=document.createElement('button');" +
  "b.textContent='Close';b.onclick=()=>d.remove();d.append(b);document.documentElement.append(d);};s.onload=()=>s.remove();" +
  "document.documentElement.append(s);})()";
await writeFile(resolve(dist, "remote-loader.txt"), "javascript:" + encodeURIComponent(loader) + "\n");
if (apiKey) {
  // Credential-bearing outputs are isolated under an ignored directory, outside the web root.
  const privateDir = resolve(dir, "../secrets");
  await mkdir(privateDir, { recursive: true });
  await writeFile(resolve(privateDir, "bookmarklet-with-key.txt"),
    "javascript:" + encodeURIComponent(await bundle(apiKey)) + "\n", { mode: 0o600 });
}
console.log("Built public script, remote loader and standalone Favourite. Public outputs contain no API key.");
