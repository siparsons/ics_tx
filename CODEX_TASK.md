# Outlook Web to Yodeck Calendar Bridge

Implement the full 30-section user specification with .NET 8, SQLite, vanilla JavaScript, Web Crypto, Docker, Render and xUnit. The user's explicit clarification is mandatory: serialize and encrypt calendar JSON in the browser before posting. No plaintext upload fallback.

The later requirement adds bookmark-defined calendar names via the calendar query parameter. Authenticate the name inside the encrypted snapshot too, and isolate storage, replacements, event identities and feed reads by name. Browser JavaScript cannot obtain an OS machine name; names are explicit bookmark configuration.

Only inspect rendered Outlook calendar DOM. Never use Microsoft Graph, credentials, cookies, tokens, private application state or Microsoft APIs. Collect only title, times, location, all-day status and optional safe event ID. Diagnostics remain local with explicit copy.

Review the complete snapshot and half-open window before upload. Unknown/ambiguous dates or unparsed candidates must stop the upload. Treat raw user-provided HTML as private sample data: do not commit it. Add redacted synthetic fixtures for tenant parser support.

Run dotnet test and npm browser tests/build. Validate deployment configuration and document actual verification limits. No claims of live deployment or Yodeck playback without evidence.
