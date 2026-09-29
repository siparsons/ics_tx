import { writeFile } from "node:fs/promises";
import { buildBrowserScript, bookmarkletUrl } from "./build-utils.mjs";
const script = await buildBrowserScript({ base: "https://ics-tx.onrender.com", calendarName: "ons", key: "PASTE_API_KEY_HERE" });
await writeFile(new URL("./favourites/ONS.txt", import.meta.url), bookmarkletUrl(script) + "\n");
console.log("Built ONS Favourite with PASTE_API_KEY_HERE for manual replacement.");
