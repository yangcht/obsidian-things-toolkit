import assert from "node:assert/strict";
import test from "node:test";

import { getScrollTopToReveal } from "../src/reviewScroll";

test("keeps the calendar position when the selected date is visible", () => {
  assert.equal(
    getScrollTopToReveal(
      400,
      { top: 100, bottom: 500 },
      { top: 240, bottom: 280 }
    ),
    400
  );
});

test("scrolls the calendar to reveal a selected date outside the viewport", () => {
  assert.equal(
    getScrollTopToReveal(
      400,
      { top: 100, bottom: 500 },
      { top: 600, bottom: 640 }
    ),
    720
  );

  assert.equal(
    getScrollTopToReveal(
      100,
      { top: 100, bottom: 500 },
      { top: -300, bottom: -260 }
    ),
    0
  );
});
