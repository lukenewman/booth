/**
 * Playlist reorder arithmetic, kept pure so it can be verified without a DOM.
 * The gesture layer (pointer drag, arrow keys) decides *what* moved where;
 * this decides what the resulting order is.
 */

/**
 * Move `movedId` to the slot `targetId` currently occupies.
 * Returns null when the move is a no-op or the ids are not both present —
 * callers use that to skip the optimistic update and the network write.
 */
export function reorderTo(ids: string[], movedId: string, targetId: string): string[] | null {
  if (movedId === targetId) return null;
  const from = ids.indexOf(movedId);
  const to = ids.indexOf(targetId);
  if (from < 0 || to < 0) return null;

  // Insert at the target's index *in the original array*, so the moved row
  // ends up in the slot the target occupied — after it when moving down,
  // before it when moving up.
  //
  // The previous implementation always inserted before the target, which left
  // a dead zone: dragging a row onto its immediate successor produced the same
  // order back, so the row appeared not to move. It also disagreed with the
  // keyboard nudge about what "one slot down" means.
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, movedId);
  return next;
}

/** Nudge `id` by `delta` slots. Returns null if that would leave the list. */
export function moveByDelta(ids: string[], id: string, delta: number): string[] | null {
  const from = ids.indexOf(id);
  if (from < 0) return null;
  const to = from + delta;
  if (to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
