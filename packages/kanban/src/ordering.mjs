// dsh-kanban: where a dragged ticket lands within its column.
//
// A column is listed in queue order (priority desc, then sortOrder asc, then
// creation - see compareQueue), so a reorder has to produce a sortOrder that
// puts the ticket between its new neighbours *within the same priority tier*,
// and a priority that makes the tier agree with where it was dropped. Pure
// arithmetic over the sibling list, no store, so every edge is testable.

const STEP = 1000;
const MIN_GAP = 1e-6;

/**
 * @param {Array<{id: string, priority: number, sortOrder: number}>} siblings
 *   the column in queue order, the dragged ticket included
 * @param {string} id        the dragged ticket
 * @param {string|null|undefined} beforeId  the ticket it is dropped before; null/undefined = the end
 * @returns {{ok: true, sortOrder: number, priority: number, renumber: Array<{id: string, sortOrder: number}>}
 *          | {ok: false, code: string, message: string}}
 *   `renumber` is non-empty only when the neighbours leave no room: it respaces
 *   the other tickets of the tier (the dragged ticket's own sortOrder is final).
 */
export function placement(siblings, id, beforeId) {
  const dragged = siblings.find((s) => s.id === id);
  if (dragged === undefined) return { ok: false, code: 'not_found', message: 'the ticket is not in that column' };
  const others = siblings.filter((s) => s.id !== id);
  let index = others.length;
  if (beforeId !== undefined && beforeId !== null) {
    index = others.findIndex((s) => s.id === beforeId);
    if (index < 0) return { ok: false, code: 'not_found', message: `no ticket ${beforeId} in that column` };
  }
  const next = others[index];
  const prev = others[index - 1];
  const anchor = next ?? prev;
  const priority = anchor === undefined ? dragged.priority : anchor.priority;
  const tierPrev = prev !== undefined && prev.priority === priority ? prev : undefined;
  const tierNext = next !== undefined && next.priority === priority ? next : undefined;

  let sortOrder;
  if (tierPrev === undefined && tierNext === undefined) sortOrder = dragged.sortOrder;
  else if (tierPrev === undefined) sortOrder = tierNext.sortOrder - STEP;
  else if (tierNext === undefined) sortOrder = tierPrev.sortOrder + STEP;
  else sortOrder = (tierPrev.sortOrder + tierNext.sortOrder) / 2;

  const crowded = tierPrev !== undefined && tierNext !== undefined && tierNext.sortOrder - tierPrev.sortOrder < MIN_GAP * 2;
  if (!crowded) return { ok: true, sortOrder, priority, renumber: [] };

  // No room between the neighbours: respace the whole tier around the drop.
  const tier = others.filter((s) => s.priority === priority);
  const at = tierNext === undefined ? tier.length : tier.findIndex((s) => s.id === tierNext.id);
  const ordered = [...tier.slice(0, at), { id, sortOrder }, ...tier.slice(at)];
  const respaced = ordered.map((s, i) => ({ id: s.id, sortOrder: (i + 1) * STEP }));
  const mine = respaced.find((s) => s.id === id);
  return { ok: true, sortOrder: mine.sortOrder, priority, renumber: respaced.filter((s) => s.id !== id) };
}
