/**
 * Use a translucent clone of the dragged element as the drag image, so the
 * drop targets underneath (e.g. rail playlists) stay visible while dragging.
 *
 * The native OS drag-ghost can't be styled directly — it's a snapshot taken at
 * dragstart — so we render an off-screen semi-transparent clone and hand it to
 * `setDragImage`. Call from an `ondragstart` handler with the dragged element.
 */
export function translucentDragImage(e: DragEvent, el: HTMLElement) {
  if (!e.dataTransfer) return;
  const rect = el.getBoundingClientRect();
  const ghost = el.cloneNode(true) as HTMLElement;
  ghost.style.position = 'fixed';
  ghost.style.top = '-10000px';
  ghost.style.left = '0';
  ghost.style.width = `${rect.width}px`;
  ghost.style.margin = '0';
  ghost.style.opacity = '0.5';
  ghost.style.background = 'var(--bg-raised)';
  ghost.style.border = '1px solid var(--accent)';
  ghost.style.borderRadius = '4px';
  ghost.style.pointerEvents = 'none';
  document.body.appendChild(ghost);
  // Keep the cursor at the same spot within the row it grabbed.
  e.dataTransfer.setDragImage(ghost, e.offsetX, e.offsetY);
  // The browser snapshots the element synchronously; remove it next tick.
  setTimeout(() => ghost.remove(), 0);
}

export interface PointerDragOptions {
  /** The pointerdown event that started the drag. */
  event: PointerEvent;
  /** The row being dragged. */
  row: HTMLElement;
  /** Scroll container holding the rows; rows are matched by `[data-id]`. */
  list: HTMLElement;
  /** Called as the pointer moves over a different row. */
  onOver: (id: string | null) => void;
  /** Called on release with the row the pointer ended over (null = cancelled). */
  onDrop: (id: string | null) => void;
}

/**
 * Drag a list row with pointer events, which — unlike HTML5 drag-and-drop —
 * fire for touch as well as mouse. That is the whole reason this exists:
 * `dragstart` never fires from a finger, so a DnD-only reorder is not degraded
 * on a phone, it is entirely dead.
 *
 * Uses setPointerCapture so the gesture keeps tracking once the pointer leaves
 * the row it grabbed. The handle must set `touch-action: none` or the browser
 * claims the gesture for scrolling and no pointermove ever arrives.
 */
export function startPointerDrag(opts: PointerDragOptions): void {
  const { event, row, list, onOver, onDrop } = opts;
  event.preventDefault();
  event.stopPropagation();
  row.setPointerCapture?.(event.pointerId);

  const startOpacity = row.style.opacity;
  row.style.opacity = '0.5';

  function rowIdAt(clientX: number, clientY: number): string | null {
    for (const el of list.querySelectorAll<HTMLElement>('[data-id]')) {
      const r = el.getBoundingClientRect();
      if (clientY >= r.top && clientY <= r.bottom && clientX >= r.left && clientX <= r.right) {
        return el.dataset.id ?? null;
      }
    }
    return null;
  }

  let lastId: string | null = null;

  function move(e: PointerEvent) {
    const id = rowIdAt(e.clientX, e.clientY);
    if (id !== lastId) {
      lastId = id;
      onOver(id);
    }
  }

  function finish(e: PointerEvent, cancelled: boolean) {
    row.style.opacity = startOpacity;
    row.releasePointerCapture?.(e.pointerId);
    row.removeEventListener('pointermove', move);
    row.removeEventListener('pointerup', up);
    row.removeEventListener('pointercancel', cancel);
    onOver(null);
    onDrop(cancelled ? null : rowIdAt(e.clientX, e.clientY));
  }

  function up(e: PointerEvent) { finish(e, false); }
  function cancel(e: PointerEvent) { finish(e, true); }

  row.addEventListener('pointermove', move);
  row.addEventListener('pointerup', up);
  row.addEventListener('pointercancel', cancel);
}
