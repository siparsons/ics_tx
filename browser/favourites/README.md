# Calendar Favourites

Use `UKHSA.txt` for the UKHSA calendar or `ONS.txt` for ONS. On GitHub, select **Raw** and copy the complete single line. In your local copy, replace the single `PASTE_API_KEY_HERE` with your existing upload API key, then paste it into the Edge Favourite's URL.

The committed files contain no key and do not prompt for one. Keep the placeholder in GitHub. Private ready-to-use copies belong only in the ignored `secrets/` directory.

Both Favourites upload to `https://ics-tx.onrender.com`, remember the sync interval and require Outlook and the companion tab to remain open. Replace the Favourite and click it again after a code update; it replaces the old timer and reuses its companion connection. No Outlook page reload is required.

Appointments overlapping the visible week are included with their full dates, including annual leave starting before the first visible day. Events entirely outside the displayed window are still rejected.

Rebuild from the repository root:

```powershell
node browser/build-ons-favourite.mjs ons
node browser/build-ons-favourite.mjs ukhsa
```
