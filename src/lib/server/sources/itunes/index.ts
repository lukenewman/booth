import type { MusicSource } from '../types';
import { syncITunesLibrary } from './sync';

export const itunesSource: MusicSource = {
  id: 'itunes',
  name: 'Apple Music.app',
  contributes: ['track', 'release'],
  sync: syncITunesLibrary,
};
