/**
 * Global keyboard dispatcher for the explorer.
 *
 *   /          focus search
 *   s          open scanner overlay (when in add:discogs)
 *   ↑/↓        move highlight in listview (deferred — see BACKLOG.md)
 *   ⏎          add CTA in detail (when present)
 *   Esc        clear search input / close scanner / blur input
 *   u, ⌘Z      undo last add
 *   ?          toggle shortcut overlay
 */

export interface KeyboardActions {
  focusSearch: () => void;
  openScanner: () => void;
  moveDown: () => void;
  moveUp: () => void;
  commit: () => void;
  cancel: () => void;
  undoLast: () => void;
  toggleShortcuts: () => void;
}

export interface KeyboardGuards {
  isScannerOpen: () => boolean;
}

export function installKeyboard(actions: KeyboardActions, guards: KeyboardGuards): () => void {
  function onKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inEditable =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;

    // Esc always (clear search / close scanner / blur input)
    if (e.key === 'Escape') {
      e.preventDefault();
      actions.cancel();
      return;
    }

    // Cmd/Ctrl+Z always (overrides browser undo on body)
    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      // Browser intercepts when input is focused — known gap, see CONTEXT.md.
      e.preventDefault();
      actions.undoLast();
      return;
    }

    if (inEditable) {
      if (e.key === 'Enter') { e.preventDefault(); actions.commit(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); actions.moveDown(); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); actions.moveUp();   return; }
      return;
    }

    if (e.key === '/')                                     { e.preventDefault(); actions.focusSearch();    return; }
    if ((e.key === 's' || e.key === 'S') && !guards.isScannerOpen())
                                                            { e.preventDefault(); actions.openScanner();    return; }
    if (e.key === 'ArrowDown')                              { e.preventDefault(); actions.moveDown();       return; }
    if (e.key === 'ArrowUp')                                { e.preventDefault(); actions.moveUp();         return; }
    if (e.key === 'Enter')                                  { e.preventDefault(); actions.commit();         return; }
    if (e.key === 'u' || e.key === 'U')                     { e.preventDefault(); actions.undoLast();       return; }
    if (e.key === '?')                                      { e.preventDefault(); actions.toggleShortcuts(); return; }
  }

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
