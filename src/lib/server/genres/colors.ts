import type { Database } from 'bun:sqlite';
import { PALETTE_SIZE, GENRES } from '../../genres';
import { loadVocabulary } from './resolve';

function ranked(db: Database) {
  return db.prepare(
    `SELECT name, COUNT(*) AS n FROM release_genre WHERE kind = 'style' GROUP BY name ORDER BY n DESC, name`,
  ).all() as { name: string; n: number }[];
}

function slotUse(db: Database): number[] {
  const use: number[] = Array(PALETTE_SIZE).fill(0);
  for (const r of db.prepare(`SELECT slot FROM style_color`).all() as { slot: number }[]) use[r.slot]++;
  return use;
}

/**
 * Give every style without a colour one, most-used first, each taking the
 * least-used slot (lowest on a tie). On an empty table that is the ranking:
 * the twelve most common styles each get their own hue. Afterwards a new style
 * shares the least-crowded hue. Existing colours never move — that's what lets
 * you learn them.
 */
export function assignStyleColors(db: Database): number {
  const have = new Set((db.prepare(`SELECT style FROM style_color`).all() as { style: string }[]).map((r) => r.style));
  const fresh = ranked(db).filter((r) => !have.has(r.name));
  if (!fresh.length) return 0;
  const ins = db.prepare(`INSERT INTO style_color (style, slot) VALUES (?, ?)`);
  db.transaction(() => {
    const use = slotUse(db);
    for (const r of fresh) {
      const slot = use.indexOf(Math.min(...use));
      ins.run(r.name, slot);
      use[slot]++;
    }
  })();
  return fresh.length;
}

/** "Reassign by current use": re-rank unpinned styles; pinned ones keep their slot. */
export function reassignStyleColors(db: Database): void {
  db.transaction(() => {
    db.prepare(`DELETE FROM style_color WHERE pinned = 0`).run();
    assignStyleColors(db);
  })();
}

export function pinStyleColor(db: Database, style: string, slot: number): void {
  if (!Number.isInteger(slot) || slot < 0 || slot >= PALETTE_SIZE) throw new RangeError(`slot must be 0–${PALETTE_SIZE - 1}`);
  db.prepare(
    `INSERT INTO style_color (style, slot, pinned) VALUES (?, ?, 1)
     ON CONFLICT(style) DO UPDATE SET slot = excluded.slot, pinned = 1`,
  ).run(style, slot);
}

/** Genres, plus every known style — used or not, for the tag editor's typeahead — most-used first. */
export function listGenreVocabulary(db: Database) {
  const v = loadVocabulary(db);
  const counts = new Map(ranked(db).map((r) => [r.name, r.n]));
  const colors = new Map(
    (db.prepare(`SELECT style, slot, pinned FROM style_color`).all() as { style: string; slot: number; pinned: number }[])
      .map((r) => [r.style, r]),
  );
  const names = new Set([...v.parents.keys(), ...counts.keys()]);
  return {
    genres: [...GENRES] as string[],
    styles: [...names]
      .sort((a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || a.localeCompare(b))
      .map((name) => ({
        name,
        parents: v.parents.get(name) ?? [],
        slot: colors.get(name)?.slot ?? null,
        pinned: !!colors.get(name)?.pinned,
        releases: counts.get(name) ?? 0,
      })),
  };
}
