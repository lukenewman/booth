# Multi-Source Architecture (Slice 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** [`docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md`](../specs/2026-05-05-multi-source-architecture-design.md)

**Goal:** Replace booth's hardcoded-Discogs data layer with a generic source-adapter architecture backed by local SQLite, with two adapters wired up (Discogs, Apple Music.app) and two stubbed (Rekordbox, Plex). Headless — the existing add-record UX must keep working unchanged.

**Architecture:** New `src/lib/server/db/` (sqlite + migrations), `src/lib/server/sources/` (one directory per adapter, plus `types.ts` and `registry.ts`), `src/lib/server/library/` (collation + queries). Discogs files move from `src/lib/server/` into `src/lib/server/sources/discogs/`. The in-memory `collection-cache.ts` is deleted; its responsibilities move to the SQLite-backed `source_link` table.

**Tech Stack:** SvelteKit 2 + Svelte 5 + TypeScript. New deps: `better-sqlite3` (sync sqlite client), `plist` (Apple property list parser), `ulid` (entity id generator), `tsx` (devDep, runs verification scripts under TS).

**Verification stance:** booth has no test framework today and the spec preserves that. Each task ends with a verify step that runs the actual surface (`pnpm check`, `curl`, `sqlite3`, or a small `tsx scripts/verify-*.ts` snippet). The verification scripts are committed to `scripts/` and use temporary in-memory DBs where they touch the schema.

---

## Phase 0 — Foundation

### Task 1: Project setup (deps, env, gitignore, scripts dir)

**Files:**
- Modify: `package.json` (add deps + a couple of scripts)
- Modify: `.gitignore` (add `.booth/`)
- Modify: `.env.example` (document new env vars)
- Create: `scripts/.gitkeep`

- [x] **Step 1: Install deps**

```bash
pnpm add better-sqlite3 plist ulid
pnpm add -D @types/better-sqlite3 @types/plist tsx
```

- [x] **Step 2: Update `.env.example`**

Replace contents with:

```
# Personal access token from https://www.discogs.com/settings/developers
DISCOGS_TOKEN=

# Optional: override default collection folder (1 = "Uncategorized")
# DISCOGS_FOLDER_ID=1

# Path to Apple Music.app's "Library.xml" export.
# Modern Music.app: enable "Share Library XML with other applications" in
#   Settings → Advanced; default location is then ~/Music/Music/Library.xml
# Legacy iTunes: ~/Music/iTunes/iTunes Music Library.xml
ITUNES_XML_PATH=

# Optional: override default DB path (defaults to ./.booth/booth.db)
# BOOTH_DB_PATH=
```

- [x] **Step 3: Update `.gitignore`**

Append after the existing `# Project-specific` section:

```
# booth's local sqlite store
.booth/
```

- [x] **Step 4: Create scripts directory + add convenience scripts**

```bash
mkdir -p scripts
touch scripts/.gitkeep
```

Add these entries to `package.json` `"scripts"`:

```json
"scripts": {
  "dev": "vite dev",
  "build": "vite build",
  "preview": "vite preview",
  "prepare": "svelte-kit sync || echo ''",
  "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
  "check:watch": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json --watch",
  "tsc": "svelte-kit sync && tsc --noEmit",
  "verify": "tsx"
}
```

- [x] **Step 5: Verify**

Run: `pnpm install && pnpm check`
Expected: `0 errors and 0 warnings`. Lockfile updated.

- [x] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore .env.example scripts/.gitkeep
git commit -m "chore: add deps + env scaffolding for multi-source architecture"
```

---

### Task 2: DB connection + migration runner + schema

**Files:**
- Create: `src/lib/server/db/index.ts`
- Create: `src/lib/server/db/migrate.ts`
- Create: `src/lib/server/db/migrations/001_init.sql`
- Create: `scripts/verify-db.ts`

- [x] **Step 1: Write `001_init.sql`**

Create `src/lib/server/db/migrations/001_init.sql` with the entity tables from the spec. (Note: the `_migrations` table itself is created by the migration runner's bootstrap — see Step 2 — so it is intentionally omitted from this file. Including it here would conflict with that bootstrap on first run.)

```sql
CREATE TABLE release (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  artist      TEXT NOT NULL,
  year        INTEGER,
  country     TEXT,
  label       TEXT,
  catno       TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE track (
  id           TEXT PRIMARY KEY,
  title        TEXT NOT NULL,
  artist       TEXT NOT NULL,
  album        TEXT,
  duration_ms  INTEGER,
  release_id   TEXT REFERENCES release(id) ON DELETE SET NULL,
  position     TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE source_link (
  entity_kind   TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id     TEXT NOT NULL,
  source        TEXT NOT NULL,
  external_id   TEXT NOT NULL,
  external_url  TEXT,
  match_method  TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, source, external_id),
  UNIQUE      (entity_kind, entity_id, source)
);
CREATE INDEX idx_source_link_entity ON source_link(entity_kind, entity_id);

CREATE TABLE source_facets (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id    TEXT NOT NULL,
  source       TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (entity_kind, entity_id, source, key)
);

CREATE TABLE match_key (
  entity_kind  TEXT NOT NULL CHECK (entity_kind IN ('track','release')),
  entity_id    TEXT NOT NULL,
  key_type     TEXT NOT NULL,
  key_value    TEXT NOT NULL,
  PRIMARY KEY (entity_kind, key_type, key_value),
  UNIQUE      (entity_kind, entity_id, key_type)
);
CREATE INDEX idx_match_key_entity ON match_key(entity_kind, entity_id);
```

- [x] **Step 2: Write the migration runner**

Create `src/lib/server/db/migrate.ts`:

```ts
import type Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, 'migrations');

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );`);

  const applied = new Set(
    db.prepare('SELECT id FROM _migrations').all().map((r: any) => r.id),
  );

  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const tx = db.transaction(() => {
      db.exec(sql);
      db.prepare('INSERT INTO _migrations (id) VALUES (?)').run(file);
    });
    tx();
    console.log(`[db] applied ${file}`);
  }
}
```

- [x] **Step 3: Write the connection singleton**

Create `src/lib/server/db/index.ts`:

```ts
import Database from 'better-sqlite3';
import { env } from '$env/dynamic/private';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { runMigrations } from './migrate';

const DEFAULT_PATH = './.booth/booth.db';

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  const path = env.BOOTH_DB_PATH ?? DEFAULT_PATH;
  mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  _db = db;
  return db;
}
```

- [x] **Step 4: Write a verification script**

Create `scripts/verify-db.ts`:

```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/server/db/migrate';

const db = new Database(':memory:');
runMigrations(db);

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
  .all()
  .map((r: any) => r.name);

const expected = ['_migrations', 'match_key', 'release', 'source_facets', 'source_link', 'track'];
for (const t of expected) {
  if (!tables.includes(t)) {
    console.error(`MISSING TABLE: ${t}`);
    process.exit(1);
  }
}

const applied = db.prepare('SELECT id FROM _migrations').all();
if (applied.length !== 1) {
  console.error(`Expected 1 migration applied, got ${applied.length}`);
  process.exit(1);
}

// Re-run to confirm idempotency
runMigrations(db);
const applied2 = db.prepare('SELECT id FROM _migrations').all();
if (applied2.length !== 1) {
  console.error(`Re-run not idempotent: ${applied2.length}`);
  process.exit(1);
}

console.log('OK: tables created, migration recorded, re-run idempotent');
```

- [x] **Step 5: Run verification**

Run: `pnpm verify scripts/verify-db.ts`
Expected: `[db] applied 001_init.sql` followed by `OK: tables created, migration recorded, re-run idempotent`. Exit code 0.

- [x] **Step 6: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 7: Commit**

```bash
git add src/lib/server/db scripts/verify-db.ts
git commit -m "feat(db): sqlite connection + migration runner + initial schema"
```

---

### Task 3: Adapter contract types + (empty) registry

**Files:**
- Create: `src/lib/server/sources/types.ts`
- Create: `src/lib/server/sources/registry.ts`

- [x] **Step 1: Define contract types**

Create `src/lib/server/sources/types.ts`:

```ts
export type EntityKind = 'track' | 'release';

export interface SourceTrack {
  externalId: string;
  title: string;
  artist: string;
  album?: string;
  durationMs?: number;
  position?: string;
  filePath?: string;
  releaseExternalId?: string;
  facets?: Record<string, unknown>;
  externalUrl?: string;
}

export interface SourceRelease {
  externalId: string;
  title: string;
  artist: string;
  year?: number;
  country?: string;
  label?: string;
  catno?: string;
  facets?: Record<string, unknown>;
  externalUrl?: string;
}

export interface SyncResult {
  tracks: SourceTrack[];
  releases: SourceRelease[];
}

export interface MusicSource {
  readonly id: string;
  readonly name: string;
  readonly contributes: EntityKind[];
  sync(): Promise<SyncResult>;
}

export interface CollectionWritable {
  addToCollection(args: {
    entityId: string;
  }): Promise<{ externalId: string; instanceId?: string }>;
  removeFromCollection(args: {
    entityId: string;
    instanceId?: string;
  }): Promise<void>;
}

export class NotImplementedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotImplementedError';
  }
}
```

- [x] **Step 2: Empty registry**

Create `src/lib/server/sources/registry.ts`:

```ts
import type { MusicSource } from './types';

const sources: MusicSource[] = [];

export function registerSource(source: MusicSource): void {
  if (sources.some((s) => s.id === source.id)) {
    throw new Error(`duplicate source id: ${source.id}`);
  }
  sources.push(source);
}

export function getSource(id: string): MusicSource | undefined {
  return sources.find((s) => s.id === id);
}

export function listSources(): readonly MusicSource[] {
  return sources;
}
```

- [x] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [x] **Step 4: Commit**

```bash
git add src/lib/server/sources/types.ts src/lib/server/sources/registry.ts
git commit -m "feat(sources): adapter contract types + empty registry"
```

---

### Task 4: Normalization helpers

**Files:**
- Create: `src/lib/server/library/normalize.ts`
- Create: `scripts/verify-normalize.ts`

- [ ] **Step 1: Implement normalizers**

Create `src/lib/server/library/normalize.ts`:

```ts
function stripDiacritics(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}+/gu, '');
}

function squashAlphanumLower(s: string): string {
  return stripDiacritics(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/**
 * Match-key for cross-source release matching.
 * Returns null when year is missing — we do not match year-less releases.
 */
export function normalizeArtistAlbumYear(args: {
  artist: string;
  album: string;
  year?: number | null;
}): string | null {
  if (args.year == null) return null;
  const a = squashAlphanumLower(args.artist);
  const b = squashAlphanumLower(args.album);
  if (!a || !b) return null;
  return `${a}|${b}|${args.year}`;
}

/**
 * Match-key for cross-source track matching via filesystem path.
 * Decodes file:// URLs (Apple Music.app's Library.xml uses them).
 */
export function normalizeFilePath(input: string): string {
  let p = input;
  if (p.startsWith('file://')) {
    p = decodeURIComponent(p.slice('file://'.length));
  } else {
    try {
      p = decodeURIComponent(p);
    } catch {
      // already decoded
    }
  }
  return p.replace(/\/$/, '');
}
```

- [ ] **Step 2: Write verification**

Create `scripts/verify-normalize.ts`:

```ts
import {
  normalizeArtistAlbumYear,
  normalizeFilePath,
} from '../src/lib/server/library/normalize';

function assertEq(actual: unknown, expected: unknown, label: string) {
  if (actual !== expected) {
    console.error(`FAIL ${label}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    process.exit(1);
  }
}

assertEq(
  normalizeArtistAlbumYear({ artist: 'Daft Punk', album: 'Homework', year: 1997 }),
  'daftpunk|homework|1997',
  'basic',
);
assertEq(
  normalizeArtistAlbumYear({ artist: 'Björk', album: 'Post', year: 1995 }),
  'bjork|post|1995',
  'diacritics',
);
assertEq(
  normalizeArtistAlbumYear({
    artist: 'Daft Punk*',
    album: 'Discovery (Reissue)',
    year: 2001,
  }),
  'daftpunk|discoveryreissue|2001',
  'punctuation',
);
assertEq(
  normalizeArtistAlbumYear({ artist: 'X', album: 'Y', year: null }),
  null,
  'null year',
);
assertEq(
  normalizeArtistAlbumYear({ artist: '', album: 'Y', year: 1999 }),
  null,
  'empty artist',
);

assertEq(
  normalizeFilePath('file:///Users/luke/Music/Around%20the%20World.m4a'),
  '/Users/luke/Music/Around the World.m4a',
  'file url',
);
assertEq(
  normalizeFilePath('/Users/luke/Music/x/'),
  '/Users/luke/Music/x',
  'trailing slash',
);
assertEq(
  normalizeFilePath('/Users/luke/Music/Around the World.m4a'),
  '/Users/luke/Music/Around the World.m4a',
  'plain path',
);

console.log('OK: normalize');
```

- [ ] **Step 3: Run verification**

Run: `pnpm verify scripts/verify-normalize.ts`
Expected: `OK: normalize`. Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add src/lib/server/library/normalize.ts scripts/verify-normalize.ts
git commit -m "feat(library): match-key normalization helpers"
```

---

### Task 5: Collation core

**Files:**
- Create: `src/lib/server/library/collate.ts`
- Create: `scripts/verify-collate.ts`

- [ ] **Step 1: Implement collate**

Create `src/lib/server/library/collate.ts`:

```ts
import type Database from 'better-sqlite3';
import { ulid } from 'ulid';
import type {
  EntityKind,
  SourceRelease,
  SourceTrack,
  SyncResult,
} from '../sources/types';
import { normalizeArtistAlbumYear, normalizeFilePath } from './normalize';

export interface CollateSummary {
  rowsIn: number;
  releasesUpserted: number;
  tracksUpserted: number;
  releasesDeleted: number;
  tracksDeleted: number;
  conflicts: number;
}

type MatchMethod =
  | 'file_path'
  | 'artist_album_year'
  | 'external_id_carryover'
  | 'first_seen';

/**
 * Run a single source's SyncResult against the DB:
 *   - upsert entities (track, release) and source_links via deterministic match keys
 *   - upsert source_facets
 *   - delete source_links whose external_ids are no longer present in this sync
 *   - delete entities that have zero remaining source_links
 */
export function collate(
  db: Database.Database,
  sourceId: string,
  result: SyncResult,
): CollateSummary {
  const summary: CollateSummary = {
    rowsIn: result.tracks.length + result.releases.length,
    releasesUpserted: 0,
    tracksUpserted: 0,
    releasesDeleted: 0,
    tracksDeleted: 0,
    conflicts: 0,
  };

  const tx = db.transaction(() => {
    // Cache of external_id → entity_id created/found during this run, so tracks
    // can resolve their releaseExternalId before the release row's source_link is committed.
    const releaseLookup = new Map<string, string>();

    for (const r of result.releases) {
      const entityId = upsertRelease(db, sourceId, r, summary);
      releaseLookup.set(r.externalId, entityId);
    }

    for (const t of result.tracks) {
      upsertTrack(db, sourceId, t, releaseLookup, summary);
    }

    // Diff: drop source_links from this source whose external_id is not in the
    // current sync, then drop orphan entities.
    const externalIds = new Set<string>([
      ...result.releases.map((r) => r.externalId),
      ...result.tracks.map((t) => t.externalId),
    ]);
    summary.releasesDeleted = pruneSource(db, 'release', sourceId, externalIds);
    summary.tracksDeleted = pruneSource(db, 'track', sourceId, externalIds);
  });

  tx();
  return summary;
}

// ---- Releases ---------------------------------------------------

function upsertRelease(
  db: Database.Database,
  sourceId: string,
  r: SourceRelease,
  summary: CollateSummary,
): string {
  const matchKey = normalizeArtistAlbumYear({
    artist: r.artist,
    album: r.title,
    year: r.year,
  });

  let entityId: string | undefined;
  let method: MatchMethod = 'first_seen';

  if (matchKey) {
    const found = db
      .prepare(
        `SELECT entity_id FROM match_key
          WHERE entity_kind='release' AND key_type='artist_album_year' AND key_value=?`,
      )
      .get(matchKey) as { entity_id: string } | undefined;
    if (found) {
      entityId = found.entity_id;
      method = 'artist_album_year';
    }
  }

  if (!entityId) {
    const carry = db
      .prepare(
        `SELECT entity_id FROM source_link
          WHERE entity_kind='release' AND source=? AND external_id=?`,
      )
      .get(sourceId, r.externalId) as { entity_id: string } | undefined;
    if (carry) {
      entityId = carry.entity_id;
      method = 'external_id_carryover';
    }
  }

  if (!entityId) {
    entityId = ulid();
    db.prepare(
      `INSERT INTO release (id, title, artist, year, country, label, catno)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(entityId, r.title, r.artist, r.year ?? null, r.country ?? null, r.label ?? null, r.catno ?? null);
  } else {
    db.prepare(
      `UPDATE release
         SET title=?, artist=?, year=?, country=?, label=?, catno=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
    ).run(r.title, r.artist, r.year ?? null, r.country ?? null, r.label ?? null, r.catno ?? null, entityId);
  }

  upsertSourceLink(db, 'release', entityId, sourceId, r.externalId, r.externalUrl, method, summary);
  if (matchKey) upsertMatchKey(db, 'release', entityId, 'artist_album_year', matchKey);
  upsertFacets(db, 'release', entityId, sourceId, r.facets);

  summary.releasesUpserted++;
  return entityId;
}

// ---- Tracks -----------------------------------------------------

function upsertTrack(
  db: Database.Database,
  sourceId: string,
  t: SourceTrack,
  releaseLookup: Map<string, string>,
  summary: CollateSummary,
): string {
  const fp = t.filePath ? normalizeFilePath(t.filePath) : null;
  let entityId: string | undefined;
  let method: MatchMethod = 'first_seen';

  if (fp) {
    const found = db
      .prepare(
        `SELECT entity_id FROM match_key
          WHERE entity_kind='track' AND key_type='file_path' AND key_value=?`,
      )
      .get(fp) as { entity_id: string } | undefined;
    if (found) {
      entityId = found.entity_id;
      method = 'file_path';
    }
  }

  if (!entityId) {
    const carry = db
      .prepare(
        `SELECT entity_id FROM source_link
          WHERE entity_kind='track' AND source=? AND external_id=?`,
      )
      .get(sourceId, t.externalId) as { entity_id: string } | undefined;
    if (carry) {
      entityId = carry.entity_id;
      method = 'external_id_carryover';
    }
  }

  let releaseId: string | null = null;
  if (t.releaseExternalId) {
    releaseId = releaseLookup.get(t.releaseExternalId) ?? null;
    if (!releaseId) {
      // Look it up via source_link in case a previous run created it.
      const found = db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='release' AND source=? AND external_id=?`,
        )
        .get(sourceId, t.releaseExternalId) as { entity_id: string } | undefined;
      releaseId = found?.entity_id ?? null;
    }
  }

  if (!entityId) {
    entityId = ulid();
    db.prepare(
      `INSERT INTO track (id, title, artist, album, duration_ms, release_id, position)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entityId,
      t.title,
      t.artist,
      t.album ?? null,
      t.durationMs ?? null,
      releaseId,
      t.position ?? null,
    );
  } else {
    db.prepare(
      `UPDATE track
         SET title=?, artist=?, album=?, duration_ms=?, release_id=?, position=?,
             updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE id=?`,
    ).run(
      t.title,
      t.artist,
      t.album ?? null,
      t.durationMs ?? null,
      releaseId,
      t.position ?? null,
      entityId,
    );
  }

  upsertSourceLink(db, 'track', entityId, sourceId, t.externalId, t.externalUrl, method, summary);
  if (fp) upsertMatchKey(db, 'track', entityId, 'file_path', fp);
  upsertFacets(db, 'track', entityId, sourceId, t.facets);

  summary.tracksUpserted++;
  return entityId;
}

// ---- Shared helpers --------------------------------------------

function upsertSourceLink(
  db: Database.Database,
  kind: EntityKind,
  entityId: string,
  sourceId: string,
  externalId: string,
  externalUrl: string | undefined,
  method: MatchMethod,
  summary: CollateSummary,
): void {
  // Detect conflict: a row already exists for (kind, source, external_id) but it
  // points at a different entity_id than what our match logic just resolved.
  const existing = db
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind=? AND source=? AND external_id=?`,
    )
    .get(kind, sourceId, externalId) as { entity_id: string } | undefined;
  if (existing && existing.entity_id !== entityId) {
    summary.conflicts++;
    return; // leave existing alone in Slice 1
  }

  db.prepare(
    `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, source, external_id) DO UPDATE SET
       entity_id    = excluded.entity_id,
       external_url = excluded.external_url,
       match_method = excluded.match_method`,
  ).run(kind, entityId, sourceId, externalId, externalUrl ?? null, method);
}

function upsertMatchKey(
  db: Database.Database,
  kind: EntityKind,
  entityId: string,
  keyType: string,
  keyValue: string,
): void {
  // Two unique constraints on this table:
  //   PK   (entity_kind, key_type, key_value)  → "this key already maps to that entity"
  //   UQ   (entity_kind, entity_id, key_type)  → "this entity already has a key of this type"
  db.prepare(
    `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(entity_kind, key_type, key_value) DO UPDATE SET
       entity_id = excluded.entity_id`,
  ).run(kind, entityId, keyType, keyValue);
}

function upsertFacets(
  db: Database.Database,
  kind: EntityKind,
  entityId: string,
  sourceId: string,
  facets: Record<string, unknown> | undefined,
): void {
  if (!facets) return;
  const stmt = db.prepare(
    `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_kind, entity_id, source, key) DO UPDATE SET
       value      = excluded.value,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
  );
  for (const [key, val] of Object.entries(facets)) {
    if (val === undefined) continue;
    stmt.run(kind, entityId, sourceId, key, JSON.stringify(val));
  }
}

function pruneSource(
  db: Database.Database,
  kind: EntityKind,
  sourceId: string,
  keepExternalIds: Set<string>,
): number {
  const toDelete = db
    .prepare(
      `SELECT entity_id, external_id FROM source_link
        WHERE entity_kind=? AND source=?`,
    )
    .all(kind, sourceId) as { entity_id: string; external_id: string }[];

  let orphans = 0;
  for (const row of toDelete) {
    if (keepExternalIds.has(row.external_id)) continue;
    db.prepare(
      `DELETE FROM source_link
        WHERE entity_kind=? AND source=? AND external_id=?`,
    ).run(kind, sourceId, row.external_id);
    const remaining = db
      .prepare(
        `SELECT 1 FROM source_link WHERE entity_kind=? AND entity_id=? LIMIT 1`,
      )
      .get(kind, row.entity_id);
    if (!remaining) {
      const table = kind === 'track' ? 'track' : 'release';
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(row.entity_id);
      db.prepare(
        `DELETE FROM match_key WHERE entity_kind=? AND entity_id=?`,
      ).run(kind, row.entity_id);
      db.prepare(
        `DELETE FROM source_facets WHERE entity_kind=? AND entity_id=?`,
      ).run(kind, row.entity_id);
      orphans++;
    }
  }
  return orphans;
}
```

- [ ] **Step 2: Write verification covering matching, idempotency, deletion, conflict**

Create `scripts/verify-collate.ts`:

```ts
import Database from 'better-sqlite3';
import { runMigrations } from '../src/lib/server/db/migrate';
import { collate } from '../src/lib/server/library/collate';

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) fail(msg);
}

const db = new Database(':memory:');
runMigrations(db);

// --- Run 1: discogs sync, one release ---------------------------
const r1 = collate(db, 'discogs', {
  releases: [
    {
      externalId: '12721',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      country: 'France',
      label: 'Virgin',
      catno: '7243 8 42609 2 6',
      externalUrl: 'https://www.discogs.com/release/12721',
      facets: { thumb: 'https://t/h.jpg' },
    },
  ],
  tracks: [],
});
assert(r1.releasesUpserted === 1, 'r1 upserted');
const releaseRow = db.prepare('SELECT id, title FROM release').get() as any;
assert(releaseRow.title === 'Homework', 'release row exists');

// --- Run 2: itunes sync, same album, different externalId, file paths --
const r2 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      facets: { trackCount: 16 },
    },
  ],
  tracks: [
    {
      externalId: '12345',
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc123',
      filePath: 'file:///Users/luke/Music/Around%20the%20World.m4a',
      facets: { rating: 5, playCount: 47 },
    },
  ],
});
assert(r2.releasesUpserted === 1, 'r2 release upserted');
assert(r2.tracksUpserted === 1, 'r2 track upserted');

const releaseCount = db.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
assert(releaseCount.n === 1, `expected 1 release after collation, got ${releaseCount.n}`);

const sourceLinks = db
  .prepare(`SELECT source, external_id, match_method FROM source_link WHERE entity_kind='release' ORDER BY source`)
  .all() as any[];
assert(sourceLinks.length === 2, `expected 2 release source_links, got ${sourceLinks.length}`);
assert(sourceLinks[0].source === 'discogs' && sourceLinks[0].match_method === 'first_seen', 'discogs link');
assert(sourceLinks[1].source === 'itunes' && sourceLinks[1].match_method === 'artist_album_year', 'itunes link via match key');

const trackRow = db.prepare('SELECT release_id, title FROM track').get() as any;
assert(trackRow.release_id === releaseRow.id, 'track linked to release');

const facets = db
  .prepare(`SELECT key, value FROM source_facets WHERE source='itunes' AND entity_kind='track'`)
  .all() as any[];
assert(facets.length === 2, 'two itunes facets');

// --- Run 3: re-run itunes, should be idempotent (no new entity rows) ----
const r3 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
      facets: { trackCount: 16 },
    },
  ],
  tracks: [
    {
      externalId: '12345',
      title: 'Around the World',
      artist: 'Daft Punk',
      album: 'Homework',
      releaseExternalId: 'itunes-album:abc123',
      filePath: 'file:///Users/luke/Music/Around%20the%20World.m4a',
      facets: { rating: 5, playCount: 47 },
    },
  ],
});
const releaseCount2 = db.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
const trackCount2 = db.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(releaseCount2.n === 1, 're-run did not duplicate releases');
assert(trackCount2.n === 1, 're-run did not duplicate tracks');
assert(r3.conflicts === 0, 're-run produced no conflicts');

// --- Run 4: itunes drops the track, should be pruned --------------------
const r4 = collate(db, 'itunes', {
  releases: [
    {
      externalId: 'itunes-album:abc123',
      title: 'Homework',
      artist: 'Daft Punk',
      year: 1997,
    },
  ],
  tracks: [],
});
assert(r4.tracksDeleted === 1, `track should be deleted, got ${r4.tracksDeleted}`);
const trackCount4 = db.prepare('SELECT COUNT(*) AS n FROM track').get() as any;
assert(trackCount4.n === 0, 'track row gone');

// --- Run 5: discogs drops its release, but itunes still references it.
//           The release should survive (still has itunes source_link).
const r5 = collate(db, 'discogs', { releases: [], tracks: [] });
const releaseCount5 = db.prepare('SELECT COUNT(*) AS n FROM release').get() as any;
assert(releaseCount5.n === 1, `release should survive while itunes still references it, got ${releaseCount5.n}`);
const linksAfter = db.prepare("SELECT source FROM source_link WHERE entity_kind='release'").all() as any[];
assert(linksAfter.length === 1 && linksAfter[0].source === 'itunes', 'only itunes link remains');

console.log('OK: collate');
```

- [ ] **Step 3: Run verification**

Run: `pnpm verify scripts/verify-collate.ts`
Expected: `OK: collate`. Exit code 0.

- [ ] **Step 4: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/lib/server/library/collate.ts scripts/verify-collate.ts
git commit -m "feat(library): collation engine with deterministic matching"
```

---

## Phase 1 — Discogs migration

### Task 6: Move existing Discogs server files + wrap as a `MusicSource`

**Files:**
- Move: `src/lib/server/discogs.ts` → `src/lib/server/sources/discogs/api.ts`
- Move: `src/lib/server/username.ts` → `src/lib/server/sources/discogs/username.ts`
- Modify (imports only): `src/routes/api/discogs/search/+server.ts`, `src/routes/api/discogs/collection/add/+server.ts`, `src/routes/api/discogs/collection/remove/+server.ts`, `src/routes/api/discogs/collection/ids/+server.ts`, `src/lib/server/collection-cache.ts`
- Create: `src/lib/server/sources/discogs/sync.ts`
- Create: `src/lib/server/sources/discogs/index.ts`
- Modify: `src/lib/server/sources/registry.ts` (register discogs)

- [ ] **Step 1: Move files**

```bash
mkdir -p src/lib/server/sources/discogs
git mv src/lib/server/discogs.ts src/lib/server/sources/discogs/api.ts
git mv src/lib/server/username.ts src/lib/server/sources/discogs/username.ts
```

In `src/lib/server/sources/discogs/username.ts`, change the import on line 1 from:

```ts
import { discogsFetch } from './discogs';
```

to:

```ts
import { discogsFetch } from './api';
```

- [ ] **Step 2: Update importers**

The four routes and `collection-cache.ts` import from `$lib/server/discogs` and `$lib/server/username`. Update each:

`src/routes/api/discogs/search/+server.ts`:
- `$lib/server/discogs` → `$lib/server/sources/discogs/api`
- `$lib/server/username` → `$lib/server/sources/discogs/username`

`src/routes/api/discogs/collection/add/+server.ts`: same two replacements.
`src/routes/api/discogs/collection/remove/+server.ts`: same.
`src/routes/api/discogs/collection/ids/+server.ts`: same (only the discogs one).
`src/lib/server/collection-cache.ts`: same.

- [ ] **Step 3: Type-check before adding new code**

Run: `pnpm tsc`
Expected: no errors. (This proves the rename + import update is clean before we layer new behavior on top.)

- [ ] **Step 4: Implement `sources/discogs/sync.ts`**

Create `src/lib/server/sources/discogs/sync.ts`:

```ts
import { discogsFetch } from './api';
import { getUsername } from './username';
import { env } from '$env/dynamic/private';
import type { SourceRelease, SyncResult } from '../types';

interface DiscogsCollectionItem {
  id: number;
  instance_id: number;
  basic_information: {
    id: number;
    title: string;
    year: number;
    artists?: { name: string }[];
    labels?: { name: string; catno: string }[];
    formats?: { name: string }[];
    thumb?: string;
    cover_image?: string;
  };
}

interface DiscogsCollectionPage {
  pagination: { page: number; pages: number };
  releases: DiscogsCollectionItem[];
}

export async function syncDiscogsCollection(): Promise<SyncResult> {
  const folderId = env.DISCOGS_FOLDER_ID ?? '0'; // 0 = "all" folder for collection ids
  const username = await getUsername();
  const releases: SourceRelease[] = [];
  // Aggregate instances per release (collection allows duplicates).
  const instancesByRelease = new Map<number, number[]>();

  let page = 1;
  while (true) {
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases?per_page=100&page=${page}`,
    )) as DiscogsCollectionPage;

    for (const item of data.releases ?? []) {
      const id = item.basic_information.id;
      const instances = instancesByRelease.get(id) ?? [];
      instances.push(item.instance_id);
      instancesByRelease.set(id, instances);
    }

    if (page >= (data.pagination?.pages ?? 1)) break;
    page++;
  }

  // Now build a single SourceRelease per unique release id (using the most recent
  // basic_information). Re-walk if needed; for now, simplest is to fetch by id...
  // but we already have basic_information from the loop above. Let's keep it from
  // the *last* item we saw (simpler, results are equivalent for our fields).
  const lastSeen = new Map<number, DiscogsCollectionItem>();
  page = 1;
  while (true) {
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${folderId}/releases?per_page=100&page=${page}`,
    )) as DiscogsCollectionPage;
    for (const item of data.releases ?? []) {
      lastSeen.set(item.basic_information.id, item);
    }
    if (page >= (data.pagination?.pages ?? 1)) break;
    page++;
  }

  for (const [releaseId, item] of lastSeen) {
    const bi = item.basic_information;
    const artist = bi.artists?.map((a) => a.name).join(', ') || '(unknown)';
    const label = bi.labels?.[0]?.name ?? null;
    const catno = bi.labels?.[0]?.catno ?? null;
    const format = bi.formats?.map((f) => f.name).join(', ') || null;
    releases.push({
      externalId: String(releaseId),
      title: bi.title,
      artist,
      year: bi.year || undefined,
      label: label ?? undefined,
      catno: catno ?? undefined,
      externalUrl: `https://www.discogs.com/release/${releaseId}`,
      facets: {
        thumb: bi.thumb ?? null,
        coverImage: bi.cover_image ?? null,
        format,
        instanceIds: instancesByRelease.get(releaseId) ?? [],
      },
    });
  }

  return { tracks: [], releases };
}
```

> Note: the duplicated pagination loop is intentional simplicity for Slice 1 — Discogs's collection endpoint is fast and we'd rather have clear code than clever code at this stage. If perf becomes a problem, fold the two loops together.

- [ ] **Step 5: Implement the adapter and register it**

Create `src/lib/server/sources/discogs/index.ts`:

```ts
import type { MusicSource } from '../types';
import { syncDiscogsCollection } from './sync';

export const discogsSource: MusicSource = {
  id: 'discogs',
  name: 'Discogs',
  contributes: ['release'],
  sync: syncDiscogsCollection,
};
```

Modify `src/lib/server/sources/registry.ts` — add at the bottom of the file:

```ts
import { discogsSource } from './discogs';
registerSource(discogsSource);
```

- [ ] **Step 6: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 7: Smoke-test in dev**

Run: `pnpm dev`. Open `http://localhost:5173`. The existing Discogs UX (search, badge from in-memory cache) must still work — we haven't migrated reads yet, just renamed files and added the sync function. Verify:
- Search returns results.
- "✓ in collection" badge appears for owned releases.
- Adding a record still works.

Stop the dev server (`ctrl-C`).

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(discogs): move under sources/, add MusicSource adapter"
```

---

### Task 7: Generic sync route

**Files:**
- Create: `src/routes/api/sources/[id]/sync/+server.ts`

- [ ] **Step 1: Implement the route**

Create `src/routes/api/sources/[id]/sync/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSource } from '$lib/server/sources/registry';
import { collate } from '$lib/server/library/collate';
import { getDb } from '$lib/server/db';
import { NotImplementedError } from '$lib/server/sources/types';
import { DiscogsError } from '$lib/server/sources/discogs/api';

export const POST: RequestHandler = async ({ params }) => {
  const source = getSource(params.id);
  if (!source) throw error(404, `unknown source: ${params.id}`);
  try {
    const result = await source.sync();
    const summary = collate(getDb(), source.id, result);
    return json({ source: source.id, ...summary });
  } catch (e) {
    if (e instanceof NotImplementedError) {
      throw error(501, e.message);
    }
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw e;
  }
};
```

- [ ] **Step 2: Verify the Discogs sync end-to-end**

Run: `pnpm dev` (in one terminal).

In another terminal:

```bash
curl -X POST http://localhost:5173/api/sources/discogs/sync
```

Expected response (numbers vary): `{"source":"discogs","rowsIn":N,"releasesUpserted":N,"tracksUpserted":0,"releasesDeleted":0,"tracksDeleted":0,"conflicts":0}`.

Confirm the DB is populated:

```bash
sqlite3 ./.booth/booth.db "SELECT COUNT(*) FROM release; SELECT COUNT(*) FROM source_link WHERE source='discogs';"
```

Expected: both counts equal and match the size of your Discogs collection.

Stop the dev server.

- [ ] **Step 3: Commit**

```bash
git add src/routes/api/sources
git commit -m "feat(sources): generic POST /api/sources/:id/sync route"
```

---

### Task 8: Library queries + membership endpoint + client store

**Files:**
- Create: `src/lib/server/library/queries.ts`
- Create: `src/routes/api/library/membership/+server.ts`
- Modify: `src/lib/stores/collection.svelte.ts`
- Delete: `src/routes/api/discogs/collection/ids/+server.ts`

(`ResultRow.svelte` does not change — the store keeps its `Set<number>` shape, so the badge keying is unaffected.)

- [ ] **Step 1: Implement queries**

Create `src/lib/server/library/queries.ts`:

```ts
import type Database from 'better-sqlite3';

export function getMembershipExternalIds(
  db: Database.Database,
  source: string,
  entityKind: 'track' | 'release' = 'release',
): string[] {
  const rows = db
    .prepare(
      `SELECT external_id FROM source_link
        WHERE entity_kind=? AND source=?`,
    )
    .all(entityKind, source) as { external_id: string }[];
  return rows.map((r) => r.external_id);
}
```

- [ ] **Step 2: Implement membership endpoint**

Create `src/routes/api/library/membership/+server.ts`:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getMembershipExternalIds } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source');
  if (!source) throw error(400, 'source query param required');
  const kind = url.searchParams.get('entityKind') ?? 'release';
  if (kind !== 'release' && kind !== 'track') throw error(400, 'invalid entityKind');
  const externalIds = getMembershipExternalIds(getDb(), source, kind);
  return json({ externalIds });
};
```

- [ ] **Step 3: Update the client store**

Replace `src/lib/stores/collection.svelte.ts` with:

```ts
class CollectionStore {
  ids = $state<Set<number>>(new Set());
  loaded = $state(false);

  async load() {
    try {
      const res = await fetch('/api/library/membership?source=discogs');
      if (!res.ok) return;
      const data = (await res.json()) as { externalIds: string[] };
      this.ids = new Set((data.externalIds ?? []).map((s) => Number(s)));
      this.loaded = true;
    } catch {
      // silent: badges just won't show
    }
  }

  has(releaseId: number): boolean {
    return this.ids.has(releaseId);
  }

  markAdded(releaseId: number) {
    if (this.ids.has(releaseId)) return;
    const next = new Set(this.ids);
    next.add(releaseId);
    this.ids = next;
  }

  markRemoved(releaseId: number) {
    if (!this.ids.has(releaseId)) return;
    const next = new Set(this.ids);
    next.delete(releaseId);
    this.ids = next;
  }
}

export const collection = new CollectionStore();
```

The store still keys on `number` so `ResultRow.svelte` and `+page.svelte` don't change. The conversion `Number(s)` is safe — Discogs release ids are integers stringified in our DB.

- [ ] **Step 4: Delete the old endpoint**

```bash
git rm src/routes/api/discogs/collection/ids/+server.ts
```

- [ ] **Step 5: Type-check + smoke**

Run: `pnpm tsc`
Expected: no errors.

Run: `pnpm dev`

Open the app. The "✓ in collection" badge should appear on releases you own (the membership endpoint reads from the DB populated by the previous sync). Verify with:

```bash
curl 'http://localhost:5173/api/library/membership?source=discogs' | head -c 200
```

Expected: `{"externalIds":["...","..."]}` with as many entries as your collection.

Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(library): membership endpoint + queries.ts; switch client store"
```

---

### Task 9: Discogs writes + delete `collection-cache.ts` + extend add/remove flow

**Files:**
- Modify: `src/lib/server/sources/discogs/index.ts` (add `CollectionWritable` capability)
- Modify: `src/routes/api/discogs/collection/add/+server.ts`
- Modify: `src/routes/api/discogs/collection/remove/+server.ts`
- Modify: `src/routes/+page.svelte` (send the extra release fields when adding)
- Modify: `src/lib/types.ts` (extend the add request body shape)
- Delete: `src/lib/server/collection-cache.ts`

- [ ] **Step 1: Extend `discogsSource` with write capabilities**

Replace `src/lib/server/sources/discogs/index.ts` with:

```ts
import { ulid } from 'ulid';
import type { CollectionWritable, MusicSource } from '../types';
import { syncDiscogsCollection } from './sync';
import { discogsFetch } from './api';
import { getUsername } from './username';
import { env } from '$env/dynamic/private';
import { getDb } from '../../db';
import { normalizeArtistAlbumYear } from '../../library/normalize';

const FOLDER_ID = env.DISCOGS_FOLDER_ID ?? '1';

interface DiscogsAddResponse {
  instance_id: number;
}

export const discogsSource: MusicSource & CollectionWritable = {
  id: 'discogs',
  name: 'Discogs',
  contributes: ['release'],
  sync: syncDiscogsCollection,

  async addToCollection({ entityId }) {
    const db = getDb();
    const link = db
      .prepare(
        `SELECT external_id FROM source_link
          WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
      )
      .get(entityId) as { external_id: string } | undefined;
    if (!link) {
      throw new Error(`no discogs source_link for entity ${entityId}`);
    }

    const username = await getUsername();
    const data = (await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${link.external_id}`,
      { method: 'POST' },
    )) as DiscogsAddResponse;

    return { externalId: link.external_id, instanceId: data.instance_id };
  },

  async removeFromCollection({ entityId, instanceId }) {
    const db = getDb();
    const link = db
      .prepare(
        `SELECT external_id FROM source_link
          WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
      )
      .get(entityId) as { external_id: string } | undefined;
    if (!link) {
      throw new Error(`no discogs source_link for entity ${entityId}`);
    }
    if (instanceId == null) {
      throw new Error('instanceId required for discogs.removeFromCollection');
    }

    const username = await getUsername();
    await discogsFetch(
      `/users/${encodeURIComponent(username)}/collection/folders/${FOLDER_ID}/releases/${link.external_id}/instances/${instanceId}`,
      { method: 'DELETE' },
    );

    db.prepare(
      `DELETE FROM source_link
        WHERE entity_kind='release' AND entity_id=? AND source='discogs'`,
    ).run(entityId);
    // Drop orphan release if no other source still references it.
    const stillReferenced = db
      .prepare(`SELECT 1 FROM source_link WHERE entity_kind='release' AND entity_id=? LIMIT 1`)
      .get(entityId);
    if (!stillReferenced) {
      db.prepare('DELETE FROM release WHERE id=?').run(entityId);
      db.prepare(
        `DELETE FROM match_key WHERE entity_kind='release' AND entity_id=?`,
      ).run(entityId);
      db.prepare(
        `DELETE FROM source_facets WHERE entity_kind='release' AND entity_id=?`,
      ).run(entityId);
    }
  },
};

/**
 * Ensure a release entity exists for a Discogs release the user is about to add,
 * creating one if no source_link points at this Discogs id yet (typical when the
 * user is adding a record they searched for).
 *
 * Returns the entity_id.
 */
export function ensureDiscogsReleaseEntity(args: {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  thumb: string | null;
  coverImage: string | null;
}): string {
  const db = getDb();
  const externalId = String(args.releaseId);
  const existing = db
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind='release' AND source='discogs' AND external_id=?`,
    )
    .get(externalId) as { entity_id: string } | undefined;
  if (existing) return existing.entity_id;

  const entityId = ulid();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO release (id, title, artist, year, country, label, catno)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entityId,
      args.title,
      args.artist,
      args.year,
      args.country,
      args.label,
      args.catno,
    );
    db.prepare(
      `INSERT INTO source_link (entity_kind, entity_id, source, external_id, external_url, match_method)
       VALUES ('release', ?, 'discogs', ?, ?, 'first_seen')`,
    ).run(entityId, externalId, `https://www.discogs.com/release/${externalId}`);
    const matchKey = normalizeArtistAlbumYear({
      artist: args.artist,
      album: args.title,
      year: args.year,
    });
    if (matchKey) {
      db.prepare(
        `INSERT INTO match_key (entity_kind, entity_id, key_type, key_value)
         VALUES ('release', ?, 'artist_album_year', ?)
         ON CONFLICT(entity_kind, key_type, key_value) DO NOTHING`,
      ).run(entityId, matchKey);
    }
    const facets: Record<string, unknown> = {};
    if (args.thumb) facets.thumb = args.thumb;
    if (args.coverImage) facets.coverImage = args.coverImage;
    for (const [k, v] of Object.entries(facets)) {
      db.prepare(
        `INSERT INTO source_facets (entity_kind, entity_id, source, key, value)
         VALUES ('release', ?, 'discogs', ?, ?)`,
      ).run(entityId, k, JSON.stringify(v));
    }
  });
  tx();
  return entityId;
}
```

> Note: `ensureDiscogsReleaseEntity` reuses `normalizeArtistAlbumYear` from `library/normalize.ts` so a future change to normalization rules only has to be made in one place. The boundary we care about is "no adapter imports another adapter" — adapters reaching into shared `library/` helpers is fine.

- [ ] **Step 2: Update the `add` route**

Replace `src/routes/api/discogs/collection/add/+server.ts` with:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { AddResponse } from '$lib/types';
import { DiscogsError } from '$lib/server/sources/discogs/api';
import { discogsSource, ensureDiscogsReleaseEntity } from '$lib/server/sources/discogs';

interface AddRequestBody {
  releaseId: number;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  thumb: string | null;
  coverImage: string | null;
}

export const POST: RequestHandler = async ({ request }) => {
  let body: Partial<AddRequestBody>;
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const releaseId = body.releaseId;
  if (typeof releaseId !== 'number') throw error(400, 'releaseId (number) required');
  if (typeof body.title !== 'string' || typeof body.artist !== 'string') {
    throw error(400, 'title and artist (strings) required');
  }

  const entityId = ensureDiscogsReleaseEntity({
    releaseId,
    title: body.title,
    artist: body.artist,
    year: body.year ?? null,
    country: body.country ?? null,
    label: body.label ?? null,
    catno: body.catno ?? null,
    thumb: body.thumb ?? null,
    coverImage: body.coverImage ?? null,
  });

  try {
    const { externalId, instanceId } = await discogsSource.addToCollection({ entityId });
    const response: AddResponse = {
      releaseId: Number(externalId),
      instanceId: instanceId!,
    };
    return json(response);
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
```

- [ ] **Step 3: Update the `remove` route**

Replace `src/routes/api/discogs/collection/remove/+server.ts` with:

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { DiscogsError } from '$lib/server/sources/discogs/api';
import { discogsSource } from '$lib/server/sources/discogs';
import { getDb } from '$lib/server/db';

export const DELETE: RequestHandler = async ({ request }) => {
  let body: { releaseId?: number; instanceId?: number };
  try {
    body = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const { releaseId, instanceId } = body;
  if (typeof releaseId !== 'number' || typeof instanceId !== 'number') {
    throw error(400, 'releaseId and instanceId (numbers) required');
  }

  const link = getDb()
    .prepare(
      `SELECT entity_id FROM source_link
        WHERE entity_kind='release' AND source='discogs' AND external_id=?`,
    )
    .get(String(releaseId)) as { entity_id: string } | undefined;
  if (!link) throw error(404, 'release not in local DB');

  try {
    await discogsSource.removeFromCollection({ entityId: link.entity_id, instanceId });
    return json({ ok: true });
  } catch (e) {
    if (e instanceof DiscogsError) {
      return json(e.payload, { status: e.status });
    }
    throw error(500, { message: 'Unexpected error' });
  }
};
```

- [ ] **Step 4: Update the client to send the extra fields**

In `src/routes/+page.svelte`, find the `add` fetch (around line 85) and replace its body. The `pending` variable holds a `DiscogsRelease`; we already have all the fields we need.

Find:

```ts
const res = await fetch('/api/discogs/collection/add', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ releaseId: pending.id }),
});
```

Replace with:

```ts
const res = await fetch('/api/discogs/collection/add', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    releaseId: pending.id,
    title: pending.title,
    artist: pending.artist,
    year: pending.year,
    country: pending.country,
    label: pending.label,
    catno: pending.catno,
    thumb: pending.thumb,
    coverImage: pending.coverImage,
  }),
});
```

- [ ] **Step 5: Delete the old in-memory cache**

```bash
git rm src/lib/server/collection-cache.ts
```

- [ ] **Step 6: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 7: End-to-end smoke**

Run: `pnpm dev`. In the browser:
- Search for a release you don't own → click → confirm add.
- Verify badge flips to "in collection" on the same row.
- Hit `u` to undo. Verify badge flips back.
- `curl 'http://localhost:5173/api/library/membership?source=discogs'` and confirm the count matches.

Stop dev server.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(discogs): adapter writes through to DB; remove in-memory cache"
```

---

### Task 10: Auto-sync-once-if-empty + inspection endpoints

**Files:**
- Create: `src/hooks.server.ts` (or extend if it already exists)
- Create: `src/routes/api/library/tracks/+server.ts`
- Create: `src/routes/api/library/releases/+server.ts`
- Modify: `src/lib/server/library/queries.ts` (add `listTracks`, `listReleases`)

- [ ] **Step 1: Add list queries**

Append to `src/lib/server/library/queries.ts`:

```ts
export interface TrackRow {
  id: string;
  title: string;
  artist: string;
  album: string | null;
  duration_ms: number | null;
  release_id: string | null;
  position: string | null;
  source_links: { source: string; external_id: string; external_url: string | null }[];
  facets: { source: string; key: string; value: unknown }[];
}

export interface ReleaseRow {
  id: string;
  title: string;
  artist: string;
  year: number | null;
  country: string | null;
  label: string | null;
  catno: string | null;
  source_links: { source: string; external_id: string; external_url: string | null }[];
  facets: { source: string; key: string; value: unknown }[];
}

export function listTracks(
  db: Database.Database,
  opts: { source?: string; limit: number },
): TrackRow[] {
  const ids = opts.source
    ? db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='track' AND source=?
            ORDER BY entity_id DESC LIMIT ?`,
        )
        .all(opts.source, opts.limit)
        .map((r: any) => r.entity_id)
    : db
        .prepare(`SELECT id FROM track ORDER BY id DESC LIMIT ?`)
        .all(opts.limit)
        .map((r: any) => r.id);
  return ids.map((id) => loadTrack(db, id)).filter((t): t is TrackRow => t !== null);
}

export function listReleases(
  db: Database.Database,
  opts: { source?: string; limit: number },
): ReleaseRow[] {
  const ids = opts.source
    ? db
        .prepare(
          `SELECT entity_id FROM source_link
            WHERE entity_kind='release' AND source=?
            ORDER BY entity_id DESC LIMIT ?`,
        )
        .all(opts.source, opts.limit)
        .map((r: any) => r.entity_id)
    : db
        .prepare(`SELECT id FROM release ORDER BY id DESC LIMIT ?`)
        .all(opts.limit)
        .map((r: any) => r.id);
  return ids.map((id) => loadRelease(db, id)).filter((r): r is ReleaseRow => r !== null);
}

function loadTrack(db: Database.Database, id: string): TrackRow | null {
  const row = db.prepare('SELECT * FROM track WHERE id=?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    album: row.album,
    duration_ms: row.duration_ms,
    release_id: row.release_id,
    position: row.position,
    source_links: loadLinks(db, 'track', id),
    facets: loadFacets(db, 'track', id),
  };
}

function loadRelease(db: Database.Database, id: string): ReleaseRow | null {
  const row = db.prepare('SELECT * FROM release WHERE id=?').get(id) as any;
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    artist: row.artist,
    year: row.year,
    country: row.country,
    label: row.label,
    catno: row.catno,
    source_links: loadLinks(db, 'release', id),
    facets: loadFacets(db, 'release', id),
  };
}

function loadLinks(db: Database.Database, kind: 'track' | 'release', id: string) {
  return db
    .prepare(
      `SELECT source, external_id, external_url FROM source_link
        WHERE entity_kind=? AND entity_id=? ORDER BY source`,
    )
    .all(kind, id) as { source: string; external_id: string; external_url: string | null }[];
}

function loadFacets(db: Database.Database, kind: 'track' | 'release', id: string) {
  return (
    db
      .prepare(
        `SELECT source, key, value FROM source_facets
          WHERE entity_kind=? AND entity_id=? ORDER BY source, key`,
      )
      .all(kind, id) as { source: string; key: string; value: string }[]
  ).map((r) => ({ source: r.source, key: r.key, value: safeJson(r.value) }));
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
```

Make sure `import type Database from 'better-sqlite3';` is at the top of the file (it should already be — verify).

- [ ] **Step 2: Implement the inspection endpoints**

Create `src/routes/api/library/tracks/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listTracks } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 500);
  return json({ tracks: listTracks(getDb(), { source, limit }) });
};
```

Create `src/routes/api/library/releases/+server.ts`:

```ts
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listReleases } from '$lib/server/library/queries';

export const GET: RequestHandler = async ({ url }) => {
  const source = url.searchParams.get('source') ?? undefined;
  const limit = Math.min(Number(url.searchParams.get('limit') ?? '50'), 500);
  return json({ releases: listReleases(getDb(), { source, limit }) });
};
```

- [ ] **Step 3: Auto-sync-once-if-empty hook**

Create `src/hooks.server.ts`:

```ts
import type { Handle } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { discogsSource } from '$lib/server/sources/discogs';
import { collate } from '$lib/server/library/collate';

let triggered = false;

async function maybeBackfillDiscogs() {
  if (triggered) return;
  triggered = true;
  const db = getDb();
  const has = db
    .prepare(`SELECT 1 FROM source_link WHERE source='discogs' LIMIT 1`)
    .get();
  if (has) return;
  // Fire and forget — errors logged but don't fail requests.
  discogsSource
    .sync()
    .then((result) => collate(db, 'discogs', result))
    .then((s) => console.log('[boot] discogs initial sync', s))
    .catch((e) => {
      console.warn('[boot] discogs initial sync failed:', e);
      triggered = false; // allow retry on next request
    });
}

export const handle: Handle = async ({ event, resolve }) => {
  void maybeBackfillDiscogs();
  return resolve(event);
};
```

> If `src/hooks.server.ts` already exists in your worktree, merge the `handle` chain instead of replacing.

- [ ] **Step 4: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 5: Verify both endpoints**

Run: `pnpm dev`.

```bash
curl 'http://localhost:5173/api/library/releases?source=discogs&limit=3' | head -c 500
curl 'http://localhost:5173/api/library/tracks?limit=3' | head -c 200
```

Expected: the `releases` curl returns JSON with up to 3 release rows including `source_links` and `facets`. The `tracks` curl returns `{"tracks":[]}` (no track sources synced yet).

To verify auto-sync: stop dev server, delete the DB (`rm -rf .booth`), restart `pnpm dev`, hit any page once, wait ~5 seconds, then `curl 'http://localhost:5173/api/library/membership?source=discogs'` — expect non-empty `externalIds` (auto-sync ran).

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat(library): inspection endpoints + auto-sync-on-boot hook"
```

---

## Phase 2 — Apple Music.app adapter

### Task 11: Plist parsing + iTunes record types

**Files:**
- Create: `src/lib/server/sources/itunes/parse.ts`
- Create: `scripts/verify-itunes-parse.ts`
- Create: `scripts/fixtures/itunes-tiny.xml`

- [ ] **Step 1: Add a tiny fixture**

Create `scripts/fixtures/itunes-tiny.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Library Persistent ID</key><string>ABC123</string>
  <key>Tracks</key>
  <dict>
    <key>12345</key>
    <dict>
      <key>Track ID</key><integer>12345</integer>
      <key>Name</key><string>Around the World</string>
      <key>Artist</key><string>Daft Punk</string>
      <key>Album Artist</key><string>Daft Punk</string>
      <key>Album</key><string>Homework</string>
      <key>Year</key><integer>1997</integer>
      <key>Total Time</key><integer>429000</integer>
      <key>Track Number</key><integer>7</integer>
      <key>Rating</key><integer>100</integer>
      <key>Play Count</key><integer>47</integer>
      <key>Genre</key><string>Electronic</string>
      <key>Kind</key><string>Apple Lossless audio file</string>
      <key>Location</key><string>file:///Users/luke/Music/Homework/07%20Around%20the%20World.m4a</string>
    </dict>
    <key>67890</key>
    <dict>
      <key>Track ID</key><integer>67890</integer>
      <key>Name</key><string>Da Funk</string>
      <key>Artist</key><string>Daft Punk</string>
      <key>Album Artist</key><string>Daft Punk</string>
      <key>Album</key><string>Homework</string>
      <key>Year</key><integer>1997</integer>
      <key>Total Time</key><integer>328000</integer>
      <key>Track Number</key><integer>3</integer>
      <key>Location</key><string>file:///Users/luke/Music/Homework/03%20Da%20Funk.m4a</string>
    </dict>
    <key>99999</key>
    <dict>
      <key>Track ID</key><integer>99999</integer>
      <key>Name</key><string>Cloud-Only</string>
      <key>Artist</key><string>Some Artist</string>
      <key>Kind</key><string>Apple Music AAC audio file</string>
    </dict>
  </dict>
</dict>
</plist>
```

(The third track has no `Location` — it's a cloud-only entry that the parser must skip.)

- [ ] **Step 2: Implement the parser**

Create `src/lib/server/sources/itunes/parse.ts`:

```ts
import { readFileSync } from 'node:fs';
import plist from 'plist';

export interface ITunesTrack {
  trackId: number;
  name: string;
  artist: string;
  albumArtist?: string;
  album?: string;
  year?: number;
  totalTimeMs?: number;
  trackNumber?: number;
  rating?: number;       // 0..100 in iTunes; 100 = 5 stars
  playCount?: number;
  genre?: string;
  kind?: string;
  bitRate?: number;
  sampleRate?: number;
  dateAdded?: string;
  location: string;      // file:// URL — only present for tracks with files on disk
}

export interface ITunesLibrary {
  tracks: ITunesTrack[];
  /** count of entries skipped because they had no Location (cloud-only / DRM-broken) */
  skipped: number;
}

export function parseITunesLibrary(xmlPath: string): ITunesLibrary {
  const raw = readFileSync(xmlPath, 'utf8');
  const parsed = plist.parse(raw) as { Tracks?: Record<string, Record<string, unknown>> };
  const tracksDict = parsed.Tracks ?? {};

  const tracks: ITunesTrack[] = [];
  let skipped = 0;

  for (const id of Object.keys(tracksDict)) {
    const t = tracksDict[id];
    const name = t['Name'] as string | undefined;
    const artist = t['Artist'] as string | undefined;
    const location = t['Location'] as string | undefined;
    if (!name || !artist || !location) {
      skipped++;
      continue;
    }
    tracks.push({
      trackId: Number(id),
      name,
      artist,
      albumArtist: t['Album Artist'] as string | undefined,
      album: t['Album'] as string | undefined,
      year: t['Year'] as number | undefined,
      totalTimeMs: t['Total Time'] as number | undefined,
      trackNumber: t['Track Number'] as number | undefined,
      rating: t['Rating'] as number | undefined,
      playCount: t['Play Count'] as number | undefined,
      genre: t['Genre'] as string | undefined,
      kind: t['Kind'] as string | undefined,
      bitRate: t['Bit Rate'] as number | undefined,
      sampleRate: t['Sample Rate'] as number | undefined,
      dateAdded: (t['Date Added'] as Date | undefined)?.toISOString(),
      location,
    });
  }

  return { tracks, skipped };
}
```

- [ ] **Step 3: Verify against the fixture**

Create `scripts/verify-itunes-parse.ts`:

```ts
import { parseITunesLibrary } from '../src/lib/server/sources/itunes/parse';

const lib = parseITunesLibrary('scripts/fixtures/itunes-tiny.xml');

function fail(msg: string): never {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

if (lib.tracks.length !== 2) fail(`expected 2 tracks, got ${lib.tracks.length}`);
if (lib.skipped !== 1) fail(`expected 1 skipped, got ${lib.skipped}`);

const t = lib.tracks.find((x) => x.trackId === 12345);
if (!t) fail('missing track 12345');
if (t.name !== 'Around the World') fail(`name: ${t.name}`);
if (t.album !== 'Homework') fail(`album: ${t.album}`);
if (t.year !== 1997) fail(`year: ${t.year}`);
if (t.rating !== 100) fail(`rating: ${t.rating}`);
if (!t.location.includes('Around%20the%20World.m4a')) fail(`location: ${t.location}`);

console.log('OK: itunes parse');
```

Run: `pnpm verify scripts/verify-itunes-parse.ts`
Expected: `OK: itunes parse`. Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add scripts/fixtures src/lib/server/sources/itunes/parse.ts scripts/verify-itunes-parse.ts
git commit -m "feat(itunes): plist parser + tiny fixture"
```

---

### Task 12: iTunes adapter — sync + register

**Files:**
- Create: `src/lib/server/sources/itunes/sync.ts`
- Create: `src/lib/server/sources/itunes/index.ts`
- Modify: `src/lib/server/sources/registry.ts`
- Create: `scripts/verify-itunes-sync.ts`

- [ ] **Step 1: Implement `sync.ts` (group tracks → emergent releases)**

Create `src/lib/server/sources/itunes/sync.ts`:

```ts
import { createHash } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { parseITunesLibrary, type ITunesTrack } from './parse';
import type { SourceRelease, SourceTrack, SyncResult } from '../types';

function squashAlphanumLower(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}+/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function albumGroupKey(t: ITunesTrack): string | null {
  const album = t.album?.trim();
  if (!album) return null;
  const artist = (t.albumArtist ?? t.artist).trim();
  if (!artist) return null;
  const year = t.year ?? 0;
  return `${squashAlphanumLower(artist)}|${squashAlphanumLower(album)}|${year}`;
}

function syntheticReleaseId(groupKey: string): string {
  const h = createHash('sha1').update(groupKey).digest('hex').slice(0, 12);
  return `itunes-album:${h}`;
}

export async function syncITunesLibrary(): Promise<SyncResult> {
  const xmlPath = env.ITUNES_XML_PATH;
  if (!xmlPath) {
    throw new Error(
      'ITUNES_XML_PATH not set in .env — point at your Music.app Library.xml export',
    );
  }

  const lib = parseITunesLibrary(xmlPath);

  // Group tracks by album.
  const groups = new Map<string, { groupKey: string; tracks: ITunesTrack[] }>();
  for (const t of lib.tracks) {
    const groupKey = albumGroupKey(t);
    if (!groupKey) continue;
    const id = syntheticReleaseId(groupKey);
    let g = groups.get(id);
    if (!g) {
      g = { groupKey, tracks: [] };
      groups.set(id, g);
    }
    g.tracks.push(t);
  }

  const releases: SourceRelease[] = [];
  for (const [id, g] of groups) {
    // Use the first track in the group as the representative for release-level fields.
    const rep = g.tracks[0];
    releases.push({
      externalId: id,
      title: rep.album!,
      artist: (rep.albumArtist ?? rep.artist).trim(),
      year: rep.year,
      facets: { trackCount: g.tracks.length },
    });
  }

  const tracks: SourceTrack[] = lib.tracks.map((t) => {
    const groupKey = albumGroupKey(t);
    return {
      externalId: String(t.trackId),
      title: t.name,
      artist: t.artist,
      album: t.album,
      durationMs: t.totalTimeMs,
      position: t.trackNumber != null ? String(t.trackNumber) : undefined,
      filePath: t.location,
      releaseExternalId: groupKey ? syntheticReleaseId(groupKey) : undefined,
      facets: pickDefined({
        rating: t.rating,
        playCount: t.playCount,
        dateAdded: t.dateAdded,
        kind: t.kind,
        bitRate: t.bitRate,
        sampleRate: t.sampleRate,
        genre: t.genre,
      }),
    };
  });

  return { tracks, releases };
}

function pickDefined<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const k of Object.keys(o) as (keyof T)[]) {
    if (o[k] !== undefined) out[k] = o[k];
  }
  return out;
}
```

- [ ] **Step 2: Adapter + register**

Create `src/lib/server/sources/itunes/index.ts`:

```ts
import type { MusicSource } from '../types';
import { syncITunesLibrary } from './sync';

export const itunesSource: MusicSource = {
  id: 'itunes',
  name: 'Apple Music.app',
  contributes: ['track', 'release'],
  sync: syncITunesLibrary,
};
```

Append to `src/lib/server/sources/registry.ts`:

```ts
import { itunesSource } from './itunes';
registerSource(itunesSource);
```

- [ ] **Step 3: Type-check**

Run: `pnpm tsc`
Expected: no errors.

- [ ] **Step 4: Smoke-verify via dev server**

We deliberately don't add a `tsx` verification script for `syncITunesLibrary` because it imports `$env/dynamic/private` (a SvelteKit virtual module that doesn't resolve under raw Node/tsx). The parser was already verified standalone in Task 11 and the collation engine was verified standalone in Task 5; running `syncITunesLibrary` through the live dev server is the simplest end-to-end check.

Temporarily set `ITUNES_XML_PATH=scripts/fixtures/itunes-tiny.xml` in your `.env`:

```bash
echo "ITUNES_XML_PATH=$(pwd)/scripts/fixtures/itunes-tiny.xml" >> .env
pnpm dev
```

In another terminal:

```bash
curl -X POST http://localhost:5173/api/sources/itunes/sync
```

Expected response: `{"source":"itunes","rowsIn":3,"releasesUpserted":1,"tracksUpserted":2,"releasesDeleted":0,"tracksDeleted":0,"conflicts":0}`.

Then confirm a track was linked to its emergent release:

```bash
sqlite3 ./.booth/booth.db "SELECT t.title, r.title FROM track t LEFT JOIN release r ON r.id = t.release_id;"
```

Expected: two rows, both with non-null release titles ("Homework").

Stop the dev server. Remove the temporary `ITUNES_XML_PATH` line from `.env` before continuing (or replace it with your real library path now if you'd prefer).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(itunes): sync adapter + registry registration"
```

---

### Task 13: Cross-source collation manual verification

This task has no code changes — it's the end-to-end check that the whole architecture works against your real data.

- [ ] **Step 1: Set `ITUNES_XML_PATH` in `.env`**

If you haven't already, point `.env`'s `ITUNES_XML_PATH` at your real Music.app library export. Modern Music.app: open the app → Settings → Advanced → enable "Share Library XML with other applications". The XML lands at `~/Music/Music/Library.xml` (or wherever your library lives).

- [ ] **Step 2: Run both syncs**

```bash
pnpm dev   # in one terminal
```

```bash
curl -X POST http://localhost:5173/api/sources/discogs/sync
curl -X POST http://localhost:5173/api/sources/itunes/sync
```

Expected: each returns a `CollateSummary` JSON. The iTunes one will probably take a few seconds.

- [ ] **Step 3: Pick an album you have on both, check it has 2 source_links**

```bash
sqlite3 ./.booth/booth.db <<'SQL'
.headers on
.mode column
SELECT r.title, r.artist, r.year,
       GROUP_CONCAT(sl.source) AS sources,
       COUNT(sl.source) AS n
  FROM release r
  JOIN source_link sl ON sl.entity_kind='release' AND sl.entity_id=r.id
 GROUP BY r.id
 HAVING n >= 2
 ORDER BY r.artist, r.title
 LIMIT 20;
SQL
```

Expected: at least one row showing `sources = "discogs,itunes"` (or the reverse). If you get zero, that's not a bug — it means deterministic matching didn't catch any of your overlap, which is plausible for a small overlap or for releases where one source is missing the year. Spot-check by looking at one specific album you know is in both:

```bash
sqlite3 ./.booth/booth.db "SELECT * FROM release WHERE title LIKE '%Homework%' OR title LIKE '%<your album>%';"
sqlite3 ./.booth/booth.db "SELECT * FROM source_link WHERE entity_kind='release' AND entity_id IN (SELECT id FROM release WHERE title LIKE '%<your album>%');"
```

If a known-overlap album is showing up as two separate `release` rows, that's a deterministic-matching miss — note it in the implementation report; fuzzy matching is Slice 2.

- [ ] **Step 4: Inspection endpoints sanity**

```bash
curl 'http://localhost:5173/api/library/tracks?source=itunes&limit=3' | head -c 500
curl 'http://localhost:5173/api/library/releases?source=itunes&limit=3' | head -c 500
```

Expected: real data, with `facets` populated for iTunes (rating, playCount, etc.).

- [ ] **Step 5: Existing add-record flow still works**

Open the browser. Search for a release. Add it. Undo. Verify badges flip correctly and the iTunes-collated data is still intact (`sqlite3 ... "SELECT COUNT(*) FROM track;"`).

- [ ] **Step 6: Commit (notes file)**

There's no code change but it's worth recording observations. Create `docs/superpowers/plans/2026-05-05-multi-source-architecture.notes.md` with a few lines about what you observed (overlap counts, any matching misses), then:

```bash
git add docs/superpowers/plans/2026-05-05-multi-source-architecture.notes.md
git commit -m "docs: cross-source verification notes"
```

---

## Phase 3 — Stubs + finalize

### Task 14: Rekordbox + Plex stubs (registered, throwing)

**Files:**
- Create: `src/lib/server/sources/rekordbox/index.ts`
- Create: `src/lib/server/sources/plex/index.ts`
- Modify: `src/lib/server/sources/registry.ts`

- [ ] **Step 1: Stub adapters**

Create `src/lib/server/sources/rekordbox/index.ts`:

```ts
import type { MusicSource } from '../types';
import { NotImplementedError } from '../types';

export const rekordboxSource: MusicSource = {
  id: 'rekordbox',
  name: 'Rekordbox',
  contributes: ['track'],
  async sync() {
    throw new NotImplementedError(
      'Rekordbox adapter not implemented in Slice 1; see docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md §9',
    );
  },
};
```

Create `src/lib/server/sources/plex/index.ts`:

```ts
import type { MusicSource } from '../types';
import { NotImplementedError } from '../types';

export const plexSource: MusicSource = {
  id: 'plex',
  name: 'Plex',
  contributes: ['track'],
  async sync() {
    throw new NotImplementedError(
      'Plex adapter not implemented in Slice 1; see docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md §9',
    );
  },
};
```

- [ ] **Step 2: Register**

Append to `src/lib/server/sources/registry.ts`:

```ts
import { rekordboxSource } from './rekordbox';
import { plexSource } from './plex';
registerSource(rekordboxSource);
registerSource(plexSource);
```

- [ ] **Step 3: Verify the 501 path**

Run: `pnpm dev`

```bash
curl -i -X POST http://localhost:5173/api/sources/rekordbox/sync
curl -i -X POST http://localhost:5173/api/sources/plex/sync
```

Expected: both return HTTP 501 with the `NotImplementedError` message in the body.

```bash
curl -i -X POST http://localhost:5173/api/sources/nope/sync
```

Expected: HTTP 404.

Stop dev server.

- [ ] **Step 4: Type-check + commit**

Run: `pnpm tsc`
Expected: no errors.

```bash
git add -A
git commit -m "feat(sources): rekordbox + plex stubs registered"
```

---

### Task 15: Update `docs/CONTEXT.md`

**Files:**
- Modify: `docs/CONTEXT.md`

- [ ] **Step 1: Rewrite `docs/CONTEXT.md`**

The current CONTEXT.md is the source-of-truth for what's currently shipped. Update it to reflect Slice 1's realities. Replace the file's content sections (everything after the first heading) with the structure below, filling in details from the codebase as it now stands:

- **What it is** — keep the original framing; add: "data layer is now a generic source-adapter system backed by SQLite, with Discogs + Apple Music.app wired up and Rekordbox + Plex stubbed."
- **Tech** — add: `better-sqlite3`, `plist`, `ulid`. Update "no DB" to "SQLite at `./.booth/booth.db`, hand-rolled migrations in `src/lib/server/db/migrations/`."
- **Environment** — document `ITUNES_XML_PATH` and `BOOTH_DB_PATH`.
- **File map** — replace the old map with the new tree (see `docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md` §2).
- **Feature inventory** — keep Search/Scanner/Add/Undo/URL state/Setup/Rate-limit/Keyboard. Add a new section "Sources" describing manual sync endpoints, auto-sync-on-boot, the inspection endpoints, and which adapters are real vs stub.
- **Notable divergences from the original plan** — keep the existing list. Add a new top entry: "Multi-source architecture (Slice 1, 2026-05-05). See `docs/superpowers/specs/2026-05-05-multi-source-architecture-design.md` and the corresponding plan."
- **Known gaps / future work** — replace with the spec's §9 "Future work" list (verbatim or paraphrased).
- **Local development** — add `pnpm verify scripts/<name>.ts` for the verification scripts; document that the DB is auto-initialized on first server boot.

- [ ] **Step 2: Verify nothing in CONTEXT.md references deleted files**

Run:

```bash
grep -nE 'collection-cache|collection/ids' docs/CONTEXT.md
```

Expected: zero matches.

- [ ] **Step 3: Commit**

```bash
git add docs/CONTEXT.md
git commit -m "docs: update CONTEXT.md for Slice 1 (multi-source architecture)"
```

---

## Future work (carried forward verbatim from spec §9 — do not implement now)

- **Slice 2: Library explorer UI.** iTunes-style three-pane (sources/playlists, content list, detail).
- **Rekordbox adapter implementation** (read `master.db`, contribute BPM/key/cue facets).
- **Plex adapter implementation** (HTTP API, contribute streamable URL facet).
- **Fuzzy matching upgrade** (Levenshtein/token scoring fallback; `confidence` column; manual override table).
- **Track-level Discogs matching** (match individual tracks against Discogs tracklists).
- **Catno match-key** (`match_key.key_type='catno'` for distinguishing pressings).
- **Incremental sync** (per-source cursor; faster syncs).
- **File watching / scheduled sync** (mtime watch on `Library.xml`; periodic Plex polls).
- **Artist as first-class entity** (migration: `artist` table, FKs, source-link extension).
- **Booth-owned ratings/play counts** (a `user_track_data` table; UI for editing).
- **Playlists** (new entity type, source-attributed; iTunes adapter starts contributing).
- **Sync-run logging** (`sync_run` table for debugging).
- **Auth / multi-user**.
- **LAN / phone access.**
- **Bandcamp wishlist adapter** (release-first).
- **YouTube adapter** (track-first via playlist; streaming via embed).
