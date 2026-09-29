# Outlook Web → Yodeck Calendar Bridge

Manually capture the appointments rendered in an authenticated Outlook Web calendar, encrypt them in the browser, and expose a named ICS feed for Yodeck.

The bridge never signs in to Microsoft, calls Microsoft APIs, reads cookies or tokens, or accesses Outlook's internal application state. The browser sends only selected appointment fields. Diagnostics stay on the page until you explicitly copy them.

## Data flow

1. Invoke an Edge Favourite while viewing Outlook Calendar.
2. JavaScript extracts the rendered appointments and detects the full visible date window automatically.
3. JavaScript serializes the snapshot, generates a fresh AES-256 key and 96-bit IV, and encrypts using AES-GCM with a 128-bit tag and AAD `calendar-bridge-v1`.
4. JavaScript wraps the AES key with the service's RSA-OAEP/SHA-256 public key.
5. Outlook passes the encrypted envelope to a companion tab on the Bridge origin using origin-checked postMessage. That tab POSTs it over HTTPS with `X-API-Key`.
6. The API decrypts, validates and atomically replaces the named calendar's events whose **start** is within the half-open window.
7. Yodeck retrieves an ICS feed protected by a separate token.

There is no plaintext upload endpoint or fallback. A public key failure or encryption error stops the upload. Web Crypto's ciphertext includes the trailing 16-byte authentication tag.

## Multiple calendars

Use a different bookmark-defined name for each calendar, for example `work-laptop` and `meeting-room`. Names use 1–64 lowercase letters, digits, hyphens or underscores and begin with a letter or digit.

- Remote script: `/bookmark/calendar-harvester.js?calendar=work-laptop`
- Ingestion: `POST /api/v1/calendar/sync?calendar=work-laptop`
- Feed: `GET /calendar/<feed-token>.ics?calendar=work-laptop`

The same name is inside the encrypted snapshot as `calendarName`; the server rejects a mismatching query parameter. Names isolate snapshots, stale-upload checks, event IDs and feeds. No parameter selects `default`. A valid but unused name returns an empty calendar. Renaming a bookmark creates/selects another calendar; it does not migrate or delete the old one.

Browser JavaScript cannot obtain the computer's OS machine name through a standard browser API. Set the name in the bookmark build. A machine-like label is fine.

The API key and feed token are **service-wide**: each authorizes all calendar names. Names are selectors, not additional access controls. Use separate deployments if calendars require independent access credentials.

## Requirements and local development

Install a .NET SDK capable of targeting .NET 8, the ASP.NET Core 8 runtime, Node.js 20+ with npm, and PowerShell 7 or OpenSSL for key generation. Docker is needed only for container builds.

From the repository root:

```powershell
dotnet restore CalendarBridge.sln
npm --prefix browser ci
npm --prefix browser run build:bookmarklet
dotnet test CalendarBridge.sln
npm --prefix browser test
```

Backend tests include a Node/Web Crypto → .NET decryption → SQLite → ICS roundtrip, so Node must also be on PATH when running `dotnet test`.

Generate local keys and set process environment variables:

```powershell
pwsh -File scripts/generate-keypair.ps1
$env:CALENDAR_RSA_PRIVATE_KEY = Get-Content -Raw secrets/calendar-private.base64
$env:CALENDAR_API_KEY = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:CALENDAR_FEED_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
$env:CALENDAR_DB_PATH = Join-Path (Get-Location) '.local/calendar.db'
$env:CALENDAR_NAME = 'Work Calendar'
dotnet dev-certs https --trust
dotnet run --project src/CalendarBridge.Api --urls https://localhost:7043
```

Keep this terminal/environment available for the generated credentials. Copy values privately when needed; do not put them into tickets, logs or source files. The app reads environment variables; it does **not** automatically load `.env`. `.env.example` is a reference.

The local API requires HTTPS, including the public key, browser script and feed endpoints. Only `/health` accepts HTTP for platform health checks. A trusted localhost certificate may still need to be visited in Edge before browser fetches work. Do not disable certificate verification.

## Encryption keys and rotation

PowerShell 7:

```powershell
pwsh -File scripts/generate-keypair.ps1
# For a new rotation:
pwsh -File scripts/generate-keypair.ps1 -OutputDirectory secrets/rotation-2
```

Linux/macOS:

```sh
sh scripts/generate-keypair.sh
sh scripts/generate-keypair.sh secrets/rotation-2
```

Each script generates RSA-4096 PKCS#8 private PEM, public PEM, and a single-line Base64-wrapped private PEM. Existing private keys are not overwritten. Put the private PEM or its Base64 wrapper into `CALENDAR_RSA_PRIVATE_KEY`. Literal `\n` PEM line separators are also accepted.

The public-key endpoint derives only public RSA parameters. It never returns private key material. On rotation, change both the private key and `CALENDAR_RSA_KEY_ID` and redeploy. The browser caches the public key for five minutes, clears it after a rejected envelope, and requires a fresh scan after failure. Already stored calendars are unaffected by encryption-key rotation.

Rotate `CALENDAR_API_KEY` independently and update bookmarks that embed it. Rotate `CALENDAR_FEED_TOKEN` independently and update all Yodeck feed URLs.

## Environment variables

| Variable | Required / default | Purpose |
|---|---|---|
| `CALENDAR_API_KEY` | Required; random URL-safe 32–256 characters | Ingestion credential only |
| `CALENDAR_FEED_TOKEN` | Required; independently generated URL-safe 32–256 characters | Service-wide feed credential |
| `CALENDAR_RSA_PRIVATE_KEY` | Required | Private PEM or Base64-wrapped PEM |
| `CALENDAR_RSA_KEY_ID` | `primary` | Key version identifier |
| `CALENDAR_NAME` | `Work Calendar` on the server | Display name for the default feed; named feeds use their bookmark name |
| `CALENDAR_DB_PATH` | `.local/calendar.db` locally; `/var/data/calendar.db` in Docker | Persistent SQLite path |
| `CALENDAR_ALLOWED_ORIGINS` | Outlook office.com, office365.com and cloud.microsoft origins | Comma-separated HTTPS origins without trailing slashes |
| `CALENDAR_MAX_PAYLOAD_BYTES` | `262144` | Maximum encrypted request bytes, including envelope overhead |
| `CALENDAR_RETENTION_DAYS` | `90` | Remove events ending before the retention cutoff |
| `CALENDAR_PRIVACY_MODE` | `full` | `full`, `title-only` or `busy`, applied at feed generation |
| `PORT` | Supplied by Render; Docker default `10000` | HTTP listener behind TLS termination |
| `RENDER` | Supplied by Render | Trust its private proxy's HTTPS header only on Render |

Do not set `RENDER=true` on a directly exposed HTTP deployment. Other hosts must supply HTTPS directly or implement an explicitly trusted reverse proxy setup.

Build-only variables: `API_BASE_URL` sets the HTTPS service origin; `CALENDAR_NAME` sets the bookmark's calendar identifier (default `default`); optional `API_KEY` generates an ignored private bookmark. The browser's local payload limit defaults to 262144; `CalendarBridge.run({MAX_PAYLOAD_BYTES: ...})` can match a changed server limit.

## Deploy to Render

1. Push this repository to a private or public Git repository without secrets or raw Outlook samples.
2. Generate an RSA keypair locally.
3. In Render, create a Blueprint and select the repository containing `render.yaml`.
4. Review the starter web service, Frankfurt region and 1 GB persistent disk. These are paid resources; choose the appropriate region before creating them.
5. Supply `CALENDAR_RSA_PRIVATE_KEY` when prompted. Render generates independent ingestion and feed credentials. Review the remaining environment variables.
6. Deploy. The Docker build generates public browser assets, restores .NET dependencies and publishes the API. The service listens on `PORT` and uses `/health`.
7. Verify the HTTPS health endpoint returns only `{"status":"ok"}`, then verify the public-key endpoint.
8. Build the Favourite locally for the assigned HTTPS hostname and chosen calendar name.
9. Run an encrypted sample or a one-click Outlook capture, then configure Yodeck.

The runtime drops root privileges before launching .NET. The entrypoint prepares the mounted database directory for the app user. Keep one instance: this SQLite/disk design does not support horizontal scaling. Render's ordinary container filesystem is ephemeral; **the disk mounted at /var/data is required**. Back up SQLite using its online backup mechanism or stop writes before taking a consistent database/WAL copy.

If Docker is installed locally:

```sh
docker build -t calendar-bridge .
```

The Blueprint uses Render's [documented schema and disk settings](https://render.com/docs/blueprint-spec). When the Render CLI is installed, run `render blueprints validate` before deployment.

## Create the Edge Favourite

Build from the repository root, in a separate terminal so build variables do not alter server configuration:

```powershell
$env:API_BASE_URL = 'https://YOUR-SERVICE.onrender.com'
$env:CALENDAR_NAME = 'work-laptop'
$env:API_KEY = (Get-Content -Raw secrets/calendar-api-key.txt).Trim() # Must match Render CALENDAR_API_KEY
npm --prefix browser ci
npm --prefix browser run build:bookmarklet
Remove-Item Env:API_KEY
```

On POSIX shells:

```sh
API_BASE_URL=https://YOUR-SERVICE.onrender.com CALENDAR_NAME=work-laptop npm --prefix browser run build:bookmarklet
```

### Remote loader

Create any Edge Favourite, edit its URL, and paste the entire single line from `browser/dist/remote-loader.txt`. Do not paste it into the address bar, which can strip the `javascript:` prefix.

The public remote loader contains no upload key and cannot perform unattended sync by itself. For one-click use, install the private self-contained Favourite below. Programmatic callers can supply API_KEY through CalendarBridge.run(overrides); never put the key in a URL or public script.

It loads `/bookmark/calendar-harvester.js?calendar=work-laptop&v=...`. The service origin and calendar name are read from the script URL. Deployed script updates do not require replacing the Favourite. Editing the `calendar` query parameter selects a different calendar.

### Self-contained fallback

For one-click upload, paste the entire single line from `secrets/bookmarklet-with-key.txt` into a Favourite's URL. It includes the same minified source and does not fetch an external script. The build uses Terser compression and shortened internal variable names, with URL encoding that preserves literal percent signs and fragments. It does not use eval-based packing. Minification does not hide an embedded API credential. Rebuild and replace the Favourite after source changes.

The generated default uses an intentionally invalid example hostname until you configure the build. Public outputs never contain an API key and report a setup error when invoked without one. Use the private credential-bearing Favourite for one-click syncing.

To embed a revocable upload credential into a private Favourite, set `API_KEY` in the build environment and rebuild. Only `secrets/bookmarklet-with-key.txt` contains it; this ignored file stays outside `wwwroot` and Docker build inputs. Treat browser/bookmark-sync copies as recoverable client credentials. The API key grants no administration capability and ingestion is limited to 30 requests per minute per service.

Outlook CSP may block either inline execution, external script loading, or outbound `connect-src`. The standalone Favourite avoids injecting an external script into Outlook. Outlook's connect-src policy can also block direct API requests, so the Favourite opens /bookmark/companion.html on the Bridge origin. Only that companion performs network requests, to its own origin; Outlook encrypts the calendar before passing the envelope and upload credential through postMessage. No calendar contents or credentials are placed in the companion URL. Both sides check the exact origin, source window and a random connection ID. The companion lists the latest 100 upload results with timestamps, calendar names and event counts or errors, newest first. The history is held only in that tab and clears on refresh/close; it contains no meeting details, credentials or ciphertext. Browser pop-up blocking or Cross-Origin-Opener-Policy isolation may still prevent this architecture; these produce an error, and require live tenant/browser verification. Browser security policies are never disabled. Network failures report an error and make no automatic retries.

## Capture and diagnostics

1. Open an already authenticated Outlook calendar at one of the allowed hosts.
2. Select the required view/calendar and render its appointments. Expand overflow and scroll before scanning.
3. Ensure Outlook and your browser use the same timezone.
4. Click the private Favourite. It opens or reuses a Calendar Bridge companion tab; leave that tab open and return to Outlook. Allow pop-ups for Outlook if Edge blocks it. It scans, validates the detected window, encrypts and uploads immediately, then schedules fresh captures at 09:00, 13:00 and 17:00 each day in the browser's local timezone.
5. A small status notification shows progress, the uploaded count and the next scheduled run; success disappears after five seconds. Errors remain visible with Diagnostics and Stop timer buttons.

Each upload replaces the detected window, including clearing previous events when that window is empty. Only rendered appointments are captured, so select the intended calendar and fully expand its appointments before clicking. Missing or invalid dates, incomplete month grids and parser failures stop the upload instead of guessing a window. Repeated clicks during an active upload are ignored. Clicking again after it finishes runs immediately and replaces the existing timer, so schedules do not accumulate.


Deploy the rebuilt service before installing this Favourite: /bookmark/companion.html and /bookmark/companion.js must both be available. The Docker build includes them automatically.

The timer lives only in the current Outlook page. Keep both the companion tab and the intended calendar view open; every run reads the currently rendered view afresh and uses the calendar name embedded in the Favourite. Changing the selected Outlook calendar changes the data that will be sent to that name. Closing the companion stops uploads until the Favourite reopens it. Refreshing, closing or discarding the Outlook tab removes the timer: click the Favourite again after reopening. Use one scheduled tab per destination calendar.

Background throttling and computer sleep can delay scheduled times. A one-minute check and visibility/focus/online wake events catch up with one fresh upload when execution resumes, even if several slots were missed. Failed attempts wait for the next scheduled slot; no retry loop is created. The schedule follows local wall-clock hours across daylight-saving changes.

Use **Stop timer** on the notification to disable future runs (it does not cancel an upload already in progress). Advanced controls in the browser console are:
- CalendarBridge.scheduleStatus() — enabled state and next scheduled instant.
- CalendarBridge.stopSchedule() — stop the timer until the Favourite is clicked again.
- CalendarBridge.run() — perform one additional sync without changing the schedule.


Choose **Diagnostics** in the overlay, or run `window.CalendarBridge.runDiagnostics()` after loading the script. It displays visible candidate ARIA labels, titles, text, roles and an allowlist of data attributes. Copy is explicit; no diagnostics are automatically sent. Diagnostics can include personal text, so review and redact before sharing. Raw samples named `data` or `data.*` are ignored by Git and Docker.

DOM enumeration and parsing are separate in `browser/src/outlook-extractor.js`. Supported synthetic fixtures cover offset-bearing start/end data attributes and English Outlook month-view tooltips/accessibility labels. Two-line tooltips provide subject and times; the verified three-line variant also provides a location when corroborated by ARIA. The tooltip subject takes precedence over accessibility icon labels or title differences, and blank subjects become Untitled event. Single-day and multi-day all-day labels with full displayed dates are supported; month-cell dates can supply missing dates for rendered cards. Organizer names and status are not uploaded. Normal use displays only upload status; diagnostics remain an explicit action. Unknown or ambiguous dates and unreadable time ranges still stop the capture, so an incomplete snapshot cannot erase appointments already stored. Title formatting, icon labels and long subjects do not reject events; text is limited to the feed field lengths. No appointments are inferred from Outlook's private state.

Month-window detection reads timestamp prefixes from visible monthDayCell_ IDs and requires a complete contiguous 28-, 35-, or 42-day grid. This includes spillover days from adjacent months and supports either Sunday- or Monday-first views. A mismatch between those offsets and the browser timezone stops capture. Unknown or partial grids stop automatic upload. The trailing calendar identifiers are not collected.

`getVisibleDateRange()`, `extractVisibleEvents()`, `goToNextPeriod()` and `goToPreviousPeriod()` are exported for future multi-period orchestration. Navigation uses unique visible accessible controls and is never invoked automatically. The first version does not fetch hidden meetings or navigate automatically. A DOM snapshot cannot prove that Outlook has rendered every appointment; ensure the intended appointments are visible before invoking the Favourite.

## Encrypted sample

Run against a configured HTTPS instance in a terminal containing its upload credential:

```powershell
$env:API_BASE_URL = 'https://YOUR-SERVICE.onrender.com'
$env:API_KEY = $env:CALENDAR_API_KEY
$env:CALENDAR_NAME = 'sample'
node scripts/encrypted-sample.mjs
```

This uses the actual browser encryption/uploader modules and replaces tomorrow's UTC window in the **sample** calendar with one synthetic appointment. It does not print payloads or keys.

## Configure Yodeck

Use this full HTTPS URL, including the selected calendar:

```text
https://YOUR-SERVICE.onrender.com/calendar/YOUR-FEED-TOKEN.ics?calendar=work-laptop
```

Create a generic **Calendar Events Feed**, **Daily/Weekly Calendar**, or **Monthly Calendar** app, enter the ICS URL and configure its display timezone, refresh interval and screen assignment. See Yodeck's [Calendar Events Feed](https://www.yodeck.com/docs/user-manual/calendar-events-feed/) and [Daily/Weekly Calendar](https://www.yodeck.com/docs/user-manual/daily-events-calendar/) instructions. No Microsoft credentials are required by this bridge.

Keep the URL private: the token grants read access. The feed contains UTC timed events and date-only all-day events with exclusive end dates. Privacy modes affect output only: full includes locations, title-only omits locations, busy replaces titles and omits locations. The feed uses CRLF and UTF-8-aware 75-octet folding per [RFC 5545](https://datatracker.ietf.org/doc/html/rfc5545). Responses permit a private cache lifetime of 60 seconds; Yodeck may poll less frequently.

## Snapshot and validation rules

Snapshots replace only events whose start is `windowStart <= start < windowEnd` in the selected calendar/source. Omitted events in that range are deleted; events outside it stay unchanged. This is why a partial capture must not be treated as a complete month. Retention is a separate startup/six-hour cleanup based on event end time.

Overlapping captures older than or equal to the last capture are rejected with 409, including replays. Re-scan rather than blindly retrying a request with an uncertain result. Browser encryption is random per upload, while event UIDs are deterministic from calendar, source, normalized content and times. Renames/moves may change UIDs; replacement semantics remove the old event.

Limits: 2,000 events per capture; 500-character titles and locations; a maximum 366-day window/event duration; windows within five years of now; capture time no older than 24 hours and no more than five minutes in the future. Timestamps require explicit offsets. All-day dates must align with midnight in the specified timezone, with the exclusive ending date preserved. Disallowed JSON properties and embedded URLs/email addresses are rejected; browser display fields strip URLs and addresses before review.

SQLite stores decrypted event fields, so the database and backups remain sensitive. Encryption protects the application payload in transit; HTTPS also authenticates the server and protects the API credential. Key/plaintext byte buffers are cleared where possible; managed objects and browser strings cannot be reliably erased from memory.

## Troubleshooting

| Symptom | Action |
|---|---|
| Clicking the Favourite does nothing | Edit its URL and confirm it begins with javascript: and contains the entire generated line, rather than a file path. Replace an older loader with the current remote-loader.txt: it displays Loading immediately and reports script-assignment errors, blocked downloads and a 15-second timeout. If no overlay appears at all, inspect the browser Console for execution or policy errors. |
| External script is blocked | Use the self-contained Favourite from bookmarklet.txt. This includes the same harvester without injecting an external script. The companion tab handles API requests on the Bridge origin. It must be deployed and kept open. Execution restrictions or browser window isolation can still prevent operation. |
| CORS/network failure | Check the exact Outlook origin in the allowlist, the HTTPS certificate, service availability and CSP. The allowed request headers are Content-Type and X-API-Key; credentials/cookies are omitted. |
| No appointments detected or parsing stops | Use Diagnostics. Confirm the calendar view, expand hidden appointments, and adapt parsers from redacted tenant samples. An empty detected window replaces its stored events, so check the intended view is fully rendered before clicking. |
| Range unknown | Enter exact offset-bearing start and exclusive end timestamps and verify completeness. No broad range is guessed from one appointment. |
| Public-key/encryption failure | Check the public-key endpoint and RSA private key configuration. Re-scan after rotation; no plaintext fallback exists. |
| 401 | Use the current ingestion API key, not the feed token. |
| 400 | Check timestamps, supported payload shape, calendar-name match and key ID. Error responses intentionally omit plaintext and cryptographic details. |
| 409 | A newer/equal capture overlaps this window. Re-scan. |
| 413 / 429 | Reduce capture range / wait one minute. |
| Wrong/empty calendar in Yodeck | Check the exact calendar query parameter; names are case-sensitive lowercase identifiers. |
| Yodeck is stale | Verify a new snapshot reached the selected feed, then check Yodeck's polling/cache interval and timezone. Refresh headers do not force a player to poll. |
| Database disappeared after restart | Attach the persistent disk and set CALENDAR_DB_PATH within its mount. Re-capture lost snapshots; ephemeral storage cannot recover them. |
| Persistent disk permission error | Use the provided container entrypoint and app-owned directory. Do not override it with a root-only database file. |

Framework request/body logging is disabled to avoid exposing feed tokens or payloads. Application logs contain generic failures and successful event counts only. Check hosting/proxy access-log settings too, because the feed token is part of the URL.

## Verification and deployment status

Automated tests exercise authentication, encryption/tag/AAD/key failures, strict validation, snapshot replacement and rollback, retention, UTC/all-day ICS, escaping/folding, privacy, CORS, payload limits, rate limiting, named-calendar isolation and actual Web Crypto interoperability. Browser tests cover parsing, DOM enumeration, diagnostics selection and fail-closed upload.

A real Outlook month-view sample and a live Edge/CSP check are required before asserting tenant-specific extraction compatibility. Docker/Render deployment and Yodeck screen playback must be validated in their actual environments; a passing local test suite does not constitute a live deployment.
