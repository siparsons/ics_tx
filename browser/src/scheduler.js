export const SYNC_HOURS = [9, 13, 17];

export function nextSyncTime(now) {
  for (let day = 0; day <= 1; day++) {
    for (const hour of SYNC_HOURS) {
      const next = new Date(now);
      next.setDate(next.getDate() + day);
      next.setHours(hour, 0, 0, 0);
      if (+next > +now) return next;
    }
  }
}

// A short heartbeat also notices clock changes or resume without a visibility event.
// Only one missed slot is caught up; failed uploads wait until the next scheduled slot.
export function createScheduler(task, {
  now = () => new Date(), setTimer = setTimeout, clearTimer = clearTimeout,
  documentTarget = globalThis.document, wakeTarget = globalThis,
  isBusy = () => false, intervalMinutes = null
} = {}) {
  if (intervalMinutes !== null && (!Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 10080))
    throw new Error("Choose a whole number of minutes from 1 to 10080.");
  const nextTime = () => intervalMinutes === null ? nextSyncTime(now()) : new Date(+now() + intervalMinutes * 60000);
  let enabled = false, running = false, timer, next, lastError = null;
  function arm() {
    clearTimer(timer);
    if (enabled) timer = setTimer(check, Math.min(60000, Math.max(1000, +next - +now())));
  }
  async function execute() {
    running = true;
    try { await task(); lastError = null; }
    catch (error) { lastError = error.message || "Scheduled sync failed."; }
    finally { running = false; arm(); }
  }
  async function check() {
    if (!enabled) return;
    if (+now() >= +next && !running && !isBusy()) {
      next = nextTime();
      await execute();
    } else arm();
  }
  const wake = () => { void check(); };
  function listen(method) {
    documentTarget?.[method]("visibilitychange", wake);
    for (const name of ["focus", "pageshow", "online"]) wakeTarget?.[method]?.(name, wake);
  }
  function stop() {
    enabled = false;
    clearTimer(timer);
    listen("removeEventListener");
  }
  async function start() {
    stop();
    enabled = true;
    next = nextTime();
    listen("addEventListener");
    arm();
    if (!running && !isBusy()) await execute();
  }
  return { start, stop, check, status: () => ({
    enabled, lastError, nextRun: enabled ? next.toISOString() : null, intervalMinutes, hours: intervalMinutes === null ? [...SYNC_HOURS] : []
  }) };
}