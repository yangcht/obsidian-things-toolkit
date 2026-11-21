export const DEFAULT_SECTION_HEADING = "## Things";
export const DEFAULT_SYNC_FREQUENCY_SECONDS = 30 * 60; // Every 30 minutes
export const DEFAULT_REVIEW_WINDOW_DAYS = 365;
export const MIN_REVIEW_WINDOW_DAYS = 30;
export const MAX_REVIEW_WINDOW_DAYS = 3650;
export const MIN_SYNC_FREQUENCY_SECONDS = 60;
export const DEFAULT_TAG_PREFIX = "things/";
export const DEFAULT_CANCELLED_MARK = "c";

export function normalizeSectionHeading(rawSectionHeading: string): string {
  const sectionHeading = rawSectionHeading.trim();

  if (!sectionHeading) {
    return DEFAULT_SECTION_HEADING;
  }

  if (/^#{1,6}\s+\S/.test(sectionHeading)) {
    return sectionHeading;
  }

  const stripped = sectionHeading.replace(/^#+\s*/, "").trim();
  if (!stripped) {
    return DEFAULT_SECTION_HEADING;
  }

  return `## ${stripped}`;
}

export function normalizePositiveInteger(
  value: unknown,
  minimum: number,
  fallback: number,
  maximum?: number
): number {
  const numeric = Number(value);
  const base =
    Number.isFinite(numeric) && numeric !== 0 ? Math.floor(numeric) : fallback;
  const clampedMin = Math.max(minimum, base);
  return maximum !== undefined ? Math.min(maximum, clampedMin) : clampedMin;
}
