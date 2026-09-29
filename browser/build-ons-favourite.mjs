import { writeFile } from "node:fs/promises";
import { buildBrowserScript, bookmarkletUrl } from "./build-utils.mjs";
const script = await buildBrowserScript({ base: "https://ics-tx.onrender.com", calendarName: "ons", promptForKey: true });
await writeFile(new URL("./favourites/ONS.txt", import.meta.url), bookmarkletUrl(script) + "\n");
console.log("Built ONS Favourite without an embedded upload key.");
