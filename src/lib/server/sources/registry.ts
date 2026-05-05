import type { MusicSource } from './types';

const sources: MusicSource[] = [];

export function registerSource(source: MusicSource): void {
  if (sources.some((s) => s.id === source.id)) {
    throw new Error(`duplicate source id: ${source.id}`);
  }
  sources.push(source);
}

export function getSource(id: string): MusicSource | undefined {
  return sources.find((s) => s.id === id);
}

export function listSources(): readonly MusicSource[] {
  return sources;
}
