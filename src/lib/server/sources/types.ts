import type { Database } from 'bun:sqlite';

export type EntityKind = 'track' | 'release' | 'artist';

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
  thumbUrl?: string;
  coverUrl?: string;
  facets?: Record<string, unknown>;
  externalUrl?: string;
}

/**
 * Provenance of the data an adapter read this run. File-backed adapters report
 * it so a run whose input never changed can be flagged rather than reported as
 * a clean success — a frozen input otherwise looks identical to "nothing new".
 */
export interface SyncInput {
  /** Absolute path of the file the adapter parsed. */
  path: string;
  /** Filesystem mtime of that file, ISO. */
  mtime: string;
  /** Timestamp the file stamps on itself, when the format carries one. */
  generatedAt?: string;
}

export interface SyncResult {
  tracks: SourceTrack[];
  releases: SourceRelease[];
  input?: SyncInput;
}

export interface MusicSource {
  readonly id: string;
  readonly name: string;
  readonly contributes: EntityKind[];
  /** True for adapters whose `sync()` throws `NotImplementedError`. */
  readonly isStub?: boolean;
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

export type TrackStream =
  | { kind: 'file'; path: string; mimeType: string }
  | { kind: 'redirect'; url: string };

export interface Playable {
  resolveTrackStream(entityId: string, db: Database): Promise<TrackStream | null>;
}

export function isPlayable(source: MusicSource): source is MusicSource & Playable {
  return typeof (source as unknown as Record<string, unknown>).resolveTrackStream === 'function';
}
