#!/bin/sh
set -eu
umask 077
destination="${1:-secrets}"
mkdir -p "$destination"
if [ -e "$destination/calendar-private.pem" ]; then
  echo "Private key exists; choose a new directory for rotation." >&2
  exit 1
fi
openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out "$destination/calendar-private.pem"
openssl pkey -in "$destination/calendar-private.pem" -pubout -out "$destination/calendar-public.pem"
openssl base64 -A -in "$destination/calendar-private.pem" -out "$destination/calendar-private.base64"
printf 'Generated RSA-4096 key files in %s. Private key contents were not printed.\n' "$destination"
