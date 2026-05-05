import type { MusicSource } from '../types';
import { syncDiscogsCollection } from './sync';

export const discogsSource: MusicSource = {
  id: 'discogs',
  name: 'Discogs',
  contributes: ['release'],
  sync: syncDiscogsCollection,
};
