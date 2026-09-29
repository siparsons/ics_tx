# Calendar clash API

These read-only endpoints use the appointments already captured by Calendar Bridge. They do not connect to Outlook or initiate a new sync.

## Authentication

Send `X-Calendar-Token: <CALENDAR_FEED_TOKEN>` over HTTPS. This is the same token used in your private ICS feed URLs and grants read access only. The upload `X-API-Key` is also accepted. Do not put either credential in a query string or commit it to your page's source. Your page can request the read token from its user and hold it in memory, or have its backend supply it.

Responses use `Cache-Control: no-store`. Missing or incorrect credentials return `401`. The read token cannot upload or change appointments.

## List tracked calendars

`GET /api/v1/calendars`

Returns `{ "calendars": [...] }`, including calendars whose latest sync was empty. Each calendar contains:

| Field | Meaning |
| --- | --- |
| `name` | Calendar identifier, for example `ukhsa`, `ons`, or `test` |
| `eventCount` | Total events currently stored for this calendar, across all windows |
| `lastCapturedAt` | Time of the most recent source capture, in UTC |
| `lastImportedAt` | Time the service imported that capture, in UTC |
| `windowStart`, `windowEnd` | Start and exclusive end of that most recent capture window |

Capture metadata can be null for legacy data. Calendars are listed while they have stored events or retained snapshot history; retention can eventually remove an empty inactive calendar.

## Get clashes

`GET /api/v1/calendar/clashes`

Defaults to the next seven days across **all tracked calendars**. Every pair of overlapping appointments on different calendars produces one clash. Adjacent appointments do not clash: an appointment ending at 11:00 and another starting at 11:00 are compatible. Three mutually overlapping appointments produce three pairs. Identical appointments copied between calendars still count as overlapping; the API does not infer whether they are the same real-world meeting.

| Query parameter | Default | Meaning |
| --- | --- | --- |
| `from`, `to` | Now through seven days later | Supply both as ISO timestamps with seconds and a `Z` or explicit offset; `to` is exclusive. Maximum span is 366 days. URL-encode `+` in offsets. |
| `includeAllDay` | `true` | Include all-day events. Use `false` to check only timed appointments. |
| `includeWithinCalendar` | `false` | Also report overlapping appointments within the same calendar when `true`. |

Example request:

```text
GET /api/v1/calendar/clashes?from=2026-09-29T00:00:00Z&to=2026-10-06T00:00:00Z&includeAllDay=false
X-Calendar-Token: <your-read-token>
```

The response contains `generatedAt`, `from`, `to`, the two inclusion flags, `clashCount`, `calendars` (the metadata above), and `clashes`:

```json
{
  "id": "stable-pair-hash",
  "overlapStart": "2026-09-29T10:30:00+00:00",
  "overlapEnd": "2026-09-29T11:00:00+00:00",
  "overlapMinutes": 30,
  "first": {
    "id": "first-event-id",
    "calendarName": "ons",
    "title": "Appointment X",
    "displayTitle": "ONS: Appointment X",
    "start": "2026-09-29T10:00:00+00:00",
    "end": "2026-09-29T11:00:00+00:00",
    "allDay": false,
    "startDate": null,
    "endDate": null,
    "location": "Room A"
  },
  "second": {
    "id": "second-event-id",
    "calendarName": "ukhsa",
    "title": "Appointment Y",
    "displayTitle": "UKHSA: Appointment Y",
    "start": "2026-09-29T10:30:00+00:00",
    "end": "2026-09-29T11:30:00+00:00",
    "allDay": false,
    "startDate": null,
    "endDate": null,
    "location": "Room B"
  }
}
```

That example is one item in `clashes`. `id` identifies the pair and stays the same while the stored event identifiers stay the same, even if you change the requested range. Overlap times are clipped to your requested window; each event retains its full start/end. Results are sorted by overlap start then ID. All-day `startDate` and exclusive `endDate` are local `yyyyMMdd` dates; timestamps are UTC instants.

The service's existing privacy setting applies: `busy` returns `Busy` instead of subjects and no locations; `title-only` returns subjects without locations; `full` returns both. `displayTitle` adds the uppercase calendar label in every mode.

Invalid parameters return `400`. A request exceeding 10,000 matching events or 10,000 clash pairs returns `422` with an explanation; narrow the date window. It never returns a silently truncated list.

## Using it from your alert page

```javascript
async function loadClashes(readToken) {
  const from = new Date();
  const to = new Date(from.getTime() + 7 * 86400000);
  const query = new URLSearchParams({
    from: from.toISOString(),
    to: to.toISOString(),
    includeAllDay: "false"
  });
  const response = await fetch(`/api/v1/calendar/clashes?${query}`, {
    headers: { "X-Calendar-Token": readToken },
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Calendar API returned ${response.status}`);
  return response.json();
}
```

For a page hosted on the API's own origin, use that relative URL. For a page hosted elsewhere, use the API's full origin and add the page's exact HTTPS origin to `CALENDAR_ALLOWED_ORIGINS`; `X-Calendar-Token` is already an allowed CORS header. Render calendar titles with `textContent` rather than HTML.

Use `clashCount` for the alert count and `displayTitle`, overlap times, and `id` for its rows. An API error should be shown as unavailable, not as zero clashes. Display capture ages from `calendars` beside the result. A latest capture window is not a guarantee that every requested date was captured; previous windows can also have retained events. No clashes means none among the stored appointments, not proof that every Outlook calendar is conflict-free. Collapsed or unrendered appointments, unsynced changes, and calendars never uploaded cannot appear here. Free/busy status is not stored, so all captured events are treated as occupied time.
