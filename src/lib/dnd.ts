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
