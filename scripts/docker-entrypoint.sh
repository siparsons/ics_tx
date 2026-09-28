#!/bin/sh
set -eu
db_dir=$(dirname "${CALENDAR_DB_PATH:-/var/data/calendar.db}")
if [ "$(id -u)" = 0 ]; then
  mkdir -p "$db_dir"
  chown app:app "$db_dir"
  chmod 700 "$db_dir"
  exec gosu app dotnet CalendarBridge.Api.dll
fi
exec dotnet CalendarBridge.Api.dll
