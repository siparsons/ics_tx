# Absence API

Separates named absence entries from ordinary appointments using already captured calendars. No new Favourite or Outlook permissions are needed. An accompanying HTML widget combines all tracked calendars for DAKboard.

## Routes and authentication

- `GET /api/v1/calendar/absences?calendar=ukhsa` — send the read-only feed token as `X-Calendar-Token`, or the existing upload key as `X-API-Key`. Unauthorized requests return 401.
- `GET /dakboard/absences/{widgetKey}/data?calendar=ukhsa` — uses the same independent `DAKBOARD_WIDGET_KEY` as the clash widget; wrong/disabled keys return 404. This URL contains a read secret and must remain private.

Both support optional `calendar` (omit for all named calendars) and `timezone` (default `Europe/London`). Unknown/duplicate parameters, invalid calendar names and unknown timezones return 400. A report exceeding 10,000 candidate events returns 422 with no partial data. Busy privacy mode returns 403 rather than disclosing names. All responses use `Cache-Control: no-store`. Existing CORS restrictions remain in place: an external browser component needs an allowed origin or its own backend. A same-origin widget can fetch its data directly.

## Response

```json
{
  "generatedAt": "2026-10-12T09:00:00+00:00",
  "timezone": "Europe/London",
  "today": "2026-10-12",
  "tomorrow": "2026-10-13",
  "people": [{
    "calendarName": "ukhsa",
    "name": "Ann-Marie",
    "outNow": true,
    "outToday": true,
    "outTomorrow": false,
    "expectedReturn": "2026-10-13T00:00:00+01:00",
    "returningInDays": 1,
    "returnStatus": "expected",
    "periods": [{
      "start": "2026-10-07T00:00:00+01:00",
      "end": "2026-10-13T00:00:00+01:00",
      "allDay": true,
      "evidence": "annual leave",
      "fuzzy": false
    }]
  }],
  "unnamedAbsenceCount": 0,
  "calendars": []
}
```

`calendars` contains the usual capture metadata (shown empty above for brevity): name, eventCount, lastCapturedAt, lastImportedAt, windowStart and windowEnd. Counts remain totals of stored non-cancelled entries, including absence entries. Display capture freshness alongside the names; an old Outlook capture can still contain changed/cancelled leave. The API cannot independently confirm attendance or return dates.

`people` includes anyone with a remaining absence today or any absence tomorrow. Ended absences disappear; a morning-only absence never becomes an all-day absence. `outToday` means an absence still ongoing or starting later today, while `outNow` means currently within a recorded interval. Use `periods` for partial-day times and tomorrow's intervals. Names are grouped only within the same named calendar, ignoring case and normalizing punctuation/spacing; similar spellings are not guessed to be the same colleague.

`expectedReturn` and `returningInDays` describe the end of the earliest remaining continuous absence. Overlapping or directly adjacent entries for that person are joined when calculating it. Separate later absences do not extend it. Dates use the requested timezone, with exclusive all-day end dates and daylight saving respected. Midnight on an all-day return is a **return date**, not a claim that work starts at midnight. A timed absence ending today may be labelled “Expected back today at 12:00”; 1 day “Expected back tomorrow”; 2–7 days “Expected back in X days”. These are calendar-day differences, not business days; no weekend/work-pattern assumptions are made.

Return estimates require the latest captured window to cover the relevant interval and extend past its end. `returnStatus` is `expected`, `insufficient-coverage`, or `beyond-seven-days`. The latter two return null dates/countdowns: render “Return not yet known” or omit the return text. Do not treat the last visible day as proof of a return. Consecutive future leave beyond today/tomorrow is used to calculate the return but is not listed as a separate upcoming person.

`unnamedAbsenceCount` counts clear absence-only subjects such as “OOO” that have no usable person name; no identity is invented. The response omits original subjects, destinations and locations. Evidence strings describe the recognised absence wording, and `fuzzy` marks an approximate match.

## Detection and main calendar behaviour

Recognises named holiday shorthand such as "Jason Hols" (case-insensitive, including partial days), OOO/O.O.O./OOF, out-of-office, annual/parental/sick/compassionate and other leave, PTO and non-working days. Weaker wording (holiday, vacation, leave, training, AL) also requires an all-day entry or at least four hours. A one-character insertion/deletion/substitution in a longer absence phrase is accepted with that same duration evidence. Short acronyms and `hols` are never fuzzy-matched: words such as `holds`, `holes` and names such as `Nichols` are not holiday evidence. Names can precede or follow the absence phrase, including hyphenated names and possessives; trailing destinations/durations are not names.

Meeting discussion words (planning, policy, review, approval, handover, etc.) prevent removal. “Team Away Day”, ordinary meetings, working from home and short training meetings remain in the main ICS feed. This is a conservative heuristic, not perfect semantic recognition: ambiguous subjects remain appointments. Cancelled entries are excluded as before.

The same classifier filters recognized absences from every main ICS calendar and from clashes, before title privacy redaction. Raw entries remain stored for this endpoint and can be reclassified by later rule changes. DAKboard sees ICS removals at its next calendar-feed refresh; the bridge cannot push a refresh into its calendar block. A component can poll this endpoint every 60 seconds to update names and return labels independently.

## DAKboard visual component

Add a Website/iFrame block using `https://ics-tx.onrender.com/dakboard/absences/<DAKBOARD_WIDGET_KEY>`. Use the same private widget key as the clash component. The HTML route and its JSON route are authenticated, non-cacheable and embeddable; the page contains no upload or feed credentials.

The widget always combines **all tracked calendars**. Every person has an uppercase calendar badge, so matching names in different calendars remain distinguishable. People still away or starting later today appear under Today; those first away tomorrow appear under Tomorrow. Someone away on both days appears once, with “Also away tomorrow”. Expected return labels respect partial-day end times and unknown capture coverage. Cancelled and ended absences disappear. No recorded absences produces an explicit empty message. Clear absences without a name are counted separately.

Data refreshes every 60 seconds, with local 15-second checks removing ended absences and promoting tomorrow at midnight. Failure retains last received data with a visible warning. A report from the previous day is explicitly marked incomplete until a fresh report arrives. The footer lists every tracked calendar's capture age and warns about missing current coverage; the endpoint still relies on your Outlook captures.

Cards always form one column, filling the available block width. Start around 360 pixels wide and 850 pixels high for four people across both day sections with the larger distance-readable text. The page allows vertical scrolling if the block is too small. Increase the block's height so all names can be read at a glance. The surrounding widget is transparent with no outer panel or visible page title. Only individual cards have a translucent charcoal background. Names are at least 32px, calendar badges about 21px and absence/return details about 25px. Day headings and capture notes remain visible over the dashboard background. Calendar badges identify origin in text, with absence cards visually distinct from red clash alerts. No external scripts or fonts are loaded.

Times default to Europe/London. Append `?timezone=Europe%2FLondon` (or another valid timezone) if needed. The widget deliberately ignores a `calendar` query parameter so a copied filtered data URL cannot hide the other calendars.
