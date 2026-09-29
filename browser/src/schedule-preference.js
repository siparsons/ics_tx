export function schedulePreferenceKey(base, calendarName) {
  return "calendar-bridge:interval:v1:" + new URL(base).origin + ":" + calendarName;
}
export function validInterval(value) {
  return Number.isInteger(value) && value >= 1 && value <= 10080;
}
export function loadInterval(storage, key) {
  const raw = storage.getItem(key);
  const value = raw === null ? null : Number(raw);
  return validInterval(value) ? value : null;
}
export function saveInterval(storage, key, value) {
  if (!validInterval(value)) throw new Error("Choose a whole number of minutes from 1 to 10080.");
  storage.setItem(key, String(value));
}
