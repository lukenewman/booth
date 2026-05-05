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
