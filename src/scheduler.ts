export function getNextSyncDelayMs(
  latestSyncTime: number,
  lastSyncAttemptTime: number,
  syncInterval: number,
  now: number
): number {
  const scheduleFrom = Math.max(latestSyncTime, lastSyncAttemptTime);
  return Math.max((scheduleFrom + syncInterval - now) * 1000, 20);
}
