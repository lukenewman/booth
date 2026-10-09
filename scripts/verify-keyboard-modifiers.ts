// The single-letter shortcuts must leave ⌘/Ctrl/Alt combinations to the
// browser: ⌘C was being taken as "add to crate", so copying text never worked,
// and ⌘S / ⌘V would star or vet. Runs the real handler against a fake window.
import { installKeyboard } from '../src/lib/keyboard.svelte';

function eq(a: unknown, e: unknown, m: string) {
  if (JSON.stringify(a) !== JSON.stringify(e)) { console.error(`FAIL ${m}: got ${JSON.stringify(a)}, want ${JSON.stringify(e)}`); process.exit(1); }
}
let handler: ((e: unknown) => void) | null = null;
(globalThis as any).window = {
  addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'keydown') handler = fn; },
  removeEventListener: () => {},
};
const calls: string[] = [];
const actions = new Proxy({}, { get: (_t, name) => () => calls.push(String(name)) }) as any;
const guards = new Proxy({}, { get: () => () => false }) as any;
installKeyboard(actions, guards);

function press(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) {
  calls.length = 0;
  let prevented = false;
  handler!({
    key, code: '', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...mods,
    target: { tagName: 'BUTTON', isContentEditable: false },
    preventDefault() { prevented = true; },
    stopPropagation() {},
  });
  return { calls: [...calls], prevented };
}

for (const k of ['c', 'a', 's', 'v', 'g', 'u', 'Delete', 'Backspace', '[', ']', '/', 'Enter', 'ArrowDown']) {
  eq(press(k, { metaKey: true }), { calls: [], prevented: false }, `⌘${k} left to the browser`);
  eq(press(k, { ctrlKey: true }), { calls: [], prevented: false }, `Ctrl+${k} left to the browser`);
}
eq(press('c', { altKey: true }), { calls: [], prevented: false }, '⌥c left to the browser');
// Plain keys still work, and ⌘Z is still Booth's undo.
eq(press('c').calls, ['addToCrate'], 'c still adds to crate');
eq(press('s').calls.length, 1, 's still acts');
eq(press('z', { metaKey: true }).calls, ['undoLast'], '⌘Z still undoes');
console.log('ok verify-keyboard-modifiers');
