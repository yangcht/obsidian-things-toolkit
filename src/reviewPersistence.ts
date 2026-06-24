import type { DayReviewRating, IDailyLogbookReview } from "./settings";

export const REVIEW_FRONTMATTER_KEY = "things_toolkit_review";

const VALID_RATINGS = new Set<DayReviewRating>(["good", "steady", "improve"]);

type FrontmatterRecord = Record<string, unknown>;

function isRecord(value: unknown): value is FrontmatterRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRating(value: unknown): DayReviewRating | undefined {
  return typeof value === "string" && VALID_RATINGS.has(value as DayReviewRating)
    ? (value as DayReviewRating)
    : undefined;
}

function normalizeReflection(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeUpdatedAt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) {
      return Math.floor(timestamp / 1000);
    }
  }

  return undefined;
}

export function isDailyReviewEmpty(review: IDailyLogbookReview): boolean {
  return !review.rating && !normalizeReflection(review.reflection);
}

export function readDailyReviewFromFrontmatter(
  frontmatter: unknown
): IDailyLogbookReview | null {
  if (!isRecord(frontmatter)) {
    return null;
  }

  const rawReview = frontmatter[REVIEW_FRONTMATTER_KEY];
  if (!isRecord(rawReview)) {
    return null;
  }

  const review: IDailyLogbookReview = {
    rating: normalizeRating(rawReview.rating),
    reflection: normalizeReflection(rawReview.reflection),
    updatedAt: normalizeUpdatedAt(rawReview.updatedAt ?? rawReview.updated),
  };

  return isDailyReviewEmpty(review) ? null : review;
}

export function writeDailyReviewToFrontmatter(
  frontmatter: FrontmatterRecord,
  review: IDailyLogbookReview
): void {
  if (isDailyReviewEmpty(review)) {
    delete frontmatter[REVIEW_FRONTMATTER_KEY];
    return;
  }

  const nextReview: FrontmatterRecord = {};

  if (review.rating) {
    nextReview.rating = review.rating;
  }

  const reflection = normalizeReflection(review.reflection);
  if (reflection) {
    nextReview.reflection = reflection;
  }

  if (typeof review.updatedAt === "number" && Number.isFinite(review.updatedAt)) {
    nextReview.updatedAt = review.updatedAt;
    nextReview.updated = new Date(review.updatedAt * 1000).toISOString();
  }

  frontmatter[REVIEW_FRONTMATTER_KEY] = nextReview;
}
