interface VerticalBounds {
  bottom: number;
  top: number;
}

export function getScrollTopToReveal(
  currentScrollTop: number,
  viewport: VerticalBounds,
  target: VerticalBounds
): number {
  if (target.top >= viewport.top && target.bottom <= viewport.bottom) {
    return currentScrollTop;
  }

  const viewportCenter = (viewport.top + viewport.bottom) / 2;
  const targetCenter = (target.top + target.bottom) / 2;

  return Math.max(0, currentScrollTop + targetCenter - viewportCenter);
}
