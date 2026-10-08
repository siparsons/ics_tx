import { writeFile } from "node:fs/promises";
import { buildBrowserScript, bookmarkletUrl } from "./build-utils.mjs";
const calendarName = process.argv[2] || "ons";
if (!["ons", "ukhsa"].includes(calendarName)) throw new Error("Choose ons or ukhsa.");
const script = await buildBrowserScript({ base: "https://ics-tx.onrender.com", calendarName, key: "PASTE_API_KEY_HERE" });
await writeFile(new URL(`./favourites/${calendarName.toUpperCase()}.txt`, import.meta.url), bookmarkletUrl(script) + "\n");
console.log(`Built ${calendarName.toUpperCase()} Favourite with PASTE_API_KEY_HERE for manual replacement.`);
