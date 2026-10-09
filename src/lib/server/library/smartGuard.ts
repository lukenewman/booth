import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { isSmart } from './playlists';

/**
 * 409 for any sketch/crate/membership write to a smart playlist. The library
 * functions refuse these too (SmartPlaylistError); this turns that into a clear
 * status before any journaling happens.
 */
export function refuseSmart(playlistId: string): void {
  if (isSmart(getDb(), playlistId)) throw error(409, 'smart playlists are read-only');
}
