import { mode } from '$lib/stores/mode.svelte';

interface KeyboardActions {
  focusSearch: () => void;
  highlightUp: () => void;
  highlightDown: () => void;
  selectHighlighted: () => void;
  confirmModal: () => void;
  cancelModal: () => void;
  undoLast: () => void;
  toggleShortcuts: () => void;
}

interface KeyboardState {
  modalOpen: () => boolean;
}

export function installKeyboard(actions: KeyboardActions, state: KeyboardState) {
  function handler(e: KeyboardEvent) {
    const target = e.target as HTMLElement | null;
    const inEditable =
      target?.tagName === 'INPUT' ||
      target?.tagName === 'TEXTAREA' ||
      target?.isContentEditable;

    if (state.modalOpen()) {
      if (e.key === 'Enter') {
        e.preventDefault();
        actions.confirmModal();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        actions.cancelModal();
        return;
      }
      return;
    }

    if (mode.current === 'scanner') {
      if (e.key === 'Escape' || e.key === 's' || e.key === 'S') {
        e.preventDefault();
        mode.setSearch();
      }
      return;
    }

    // Search mode
    if (e.key === '/' && !inEditable) {
      e.preventDefault();
      actions.focusSearch();
      return;
    }

    if ((e.key === 's' || e.key === 'S') && !inEditable) {
      e.preventDefault();
      mode.setScanner();
      return;
    }

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      actions.highlightDown();
      return;
    }

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      actions.highlightUp();
      return;
    }

    if (e.key === 'Enter' && !inEditable) {
      e.preventDefault();
      actions.selectHighlighted();
      return;
    }

    if (e.key === 'Enter' && inEditable && target?.tagName === 'INPUT') {
      e.preventDefault();
      actions.selectHighlighted();
      return;
    }

    if ((e.key === 'u' || e.key === 'U') && !inEditable) {
      e.preventDefault();
      actions.undoLast();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      actions.undoLast();
      return;
    }

    if (e.key === '?') {
      e.preventDefault();
      actions.toggleShortcuts();
      return;
    }
  }

  window.addEventListener('keydown', handler);
  return () => window.removeEventListener('keydown', handler);
}
