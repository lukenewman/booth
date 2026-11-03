import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { backupStatus, removeDestination } from '$lib/server/backup/library';

/** DELETE → take the destination off the list. Its files stay where they are. 409 while it's being backed up to. */
export const DELETE: RequestHandler = ({ params }) => {
  const db = getDb();
  if (backupStatus(db).destinations.find((d) => d.destination.id === params.id)?.running) {
    return json({ error: 'Stop the backup to this folder first.' }, { status: 409 });
  }
  removeDestination(db, params.id);
  return json({ removed: true });
};
