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
