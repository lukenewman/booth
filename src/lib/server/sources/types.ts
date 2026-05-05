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
