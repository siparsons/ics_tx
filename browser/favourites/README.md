# ONS Favourite

Create an Edge Favourite named **ONS**. Replace its URL with the entire contents of `ONS.txt`, then click it while Outlook Calendar is open.

- Service: `https://ics-tx.onrender.com`
- Destination calendar: `ons`
- This committed Favourite contains no upload key. It asks for the existing `CALENDAR_API_KEY` on first use and remembers it in memory until the Outlook page is refreshed or closed. It does not ask for a Microsoft password.
- The sync interval is saved separately in Outlook site storage, so page refreshes do not reset it.
- Keep Outlook and the companion tab open. The Favourite supports the rolling seven-day view and returns to today on its first run each day.

Rebuild from the repository root with `node browser/build-ons-favourite.mjs`.

A private copy with the upload key embedded can be generated locally; keep it under the ignored `secrets/` directory, never in Git.
