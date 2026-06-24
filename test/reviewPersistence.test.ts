import assert from "node:assert/strict";
import test from "node:test";

import {
  readDailyReviewFromFrontmatter,
  REVIEW_FRONTMATTER_KEY,
  writeDailyReviewToFrontmatter,
} from "../src/reviewPersistence";

test("reads and normalizes a daily review", () => {
  const review = readDailyReviewFromFrontmatter({
    [REVIEW_FRONTMATTER_KEY]: {
      rating: "good",
      reflection: "  A useful day  ",
      updated: "2026-06-24T08:00:00.000Z",
    },
  });

  assert.deepEqual(review, {
    rating: "good",
    reflection: "A useful day",
    updatedAt: 1782288000,
  });
});

test("rejects malformed frontmatter without unsafe assumptions", () => {
  assert.equal(readDailyReviewFromFrontmatter(null), null);
  assert.equal(readDailyReviewFromFrontmatter("invalid"), null);
  assert.equal(
    readDailyReviewFromFrontmatter({ [REVIEW_FRONTMATTER_KEY]: [] }),
    null
  );
});

test("writes and removes the review property", () => {
  const frontmatter: Record<string, unknown> = {};

  writeDailyReviewToFrontmatter(frontmatter, {
    rating: "steady",
    reflection: "  Keep going  ",
    updatedAt: 1782288000,
  });

  assert.deepEqual(frontmatter[REVIEW_FRONTMATTER_KEY], {
    rating: "steady",
    reflection: "Keep going",
    updatedAt: 1782288000,
    updated: "2026-06-24T08:00:00.000Z",
  });

  writeDailyReviewToFrontmatter(frontmatter, {});
  assert.equal(REVIEW_FRONTMATTER_KEY in frontmatter, false);
});
