import { buildBrowserScript, bookmarkletUrl } from "./build-utils.mjs";
import { mkdir, writeFile, copyFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { apiOrigin } from "./src/uploader.js";

const base = apiOrigin(process.env.API_BASE_URL || "https://calendar-bridge.example.invalid");
const apiKey = process.env.API_KEY || "";
const calendarName = process.env.CALENDAR_NAME || "default";
if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(calendarName)) throw new Error("Invalid CALENDAR_NAME.");
if (apiKey && !/^[A-Za-z0-9_-]{32,256}$/.test(apiKey)) throw new Error("API_KEY must be URL-safe, 32–256 characters.");
const dir = fileURLToPath(new URL(".", import.meta.url));
async function bundle(key, entry = "calendar-harvester.js") {
  return buildBrowserScript({ base, calendarName, key, entry });
}
const publicScript = await bundle(""); // A client credential must never be published in wwwroot.
const dist = resolve(dir, "dist");
await mkdir(dist, { recursive: true });
const deployed = resolve(dir, "../src/CalendarBridge.Api/wwwroot/bookmark");
await mkdir(deployed, { recursive: true });
await writeFile(resolve(dist, "calendar-harvester.js"), publicScript + "\n");
await writeFile(resolve(deployed, "calendar-harvester.js"), publicScript + "\n");
const companionScript = await bundle("", "companion.js");
for (const target of [dist, deployed]) {
  await writeFile(resolve(target, "companion.js"), companionScript + "\n");
  await copyFile(resolve(dir, "src/companion.html"), resolve(target, "companion.html"));
}
const standalone = bookmarkletUrl(publicScript);
await writeFile(resolve(dist, "bookmarklet.txt"), standalone + "\n");
const loader = await bundle("", "remote-loader.js");
await writeFile(resolve(dist, "remote-loader.txt"), bookmarkletUrl(loader) + "\n");
if (apiKey) {
  // Credential-bearing outputs are isolated under an ignored directory, outside the web root.
  const privateDir = resolve(dir, "../secrets");
  await mkdir(privateDir, { recursive: true });
  await writeFile(resolve(privateDir, "bookmarklet-with-key.txt"),
    bookmarkletUrl(await bundle(apiKey)) + "\n", { mode: 0o600 });
}
console.log("Built public script, remote loader and standalone Favourite. Public outputs contain no API key.");
