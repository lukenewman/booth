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
