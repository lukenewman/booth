import type { MusicSource, Playable } from '../types';
import type { Database } from 'bun:sqlite';
import { syncITunesLibrary } from './sync';

function mimeFromPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  switch (ext) {
    case 'm4a': case 'aac': return 'audio/aac';
    case 'mp3': return 'audio/mpeg';
    case 'flac': return 'audio/flac';
    case 'aiff': case 'aif': return 'audio/aiff';
    default: return 'application/octet-stream';
  }
}

export const itunesSource: MusicSource & Playable = {
  id: 'itunes',
  name: 'iTunes',
  contributes: ['track', 'release'],
  sync: syncITunesLibrary,
  async resolveTrackStream(entityId: string, db: Database) {
    const row = db
      .prepare(
        `SELECT key_value FROM match_key
         WHERE entity_kind='track' AND entity_id=? AND key_type='file_path'`,
      )
      .get(entityId) as { key_value: string } | undefined;
    if (!row) return null;
    return { kind: 'file' as const, path: row.key_value, mimeType: mimeFromPath(row.key_value) };
  },
};
