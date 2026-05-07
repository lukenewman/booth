/**
 * Mirror of the explorer's URL state. The Explorer.svelte shell keeps URL ↔
 * store sync; child components read from this store.
 *
 * URL params: ?nav=<section>:<item>, ?id=<entityId>, ?q=<query>, ?entity=<releases|tracks>
 */

export type NavSection = 'library' | 'sources' | 'add';
export interface NavValue { section: NavSection; item: string; }

export type EntityKind = 'releases' | 'tracks';

const DEFAULT_NAV: NavValue = { section: 'library', item: 'all-releases' };

export function parseNav(raw: string | null): NavValue {
  if (!raw) return { ...DEFAULT_NAV };
  const [section, item] = raw.split(':');
  if (section !== 'library' && section !== 'sources' && section !== 'add') {
    return { ...DEFAULT_NAV };
  }
  if (!item) return { ...DEFAULT_NAV };
  return { section, item };
}

export function navToString(nav: NavValue): string {
  return `${nav.section}:${nav.item}`;
}

class ExplorerState {
  nav = $state<NavValue>({ ...DEFAULT_NAV });
  id = $state<string | null>(null);
  q = $state<string>('');
  entity = $state<EntityKind | null>(null); // null = use rail item's default

  /** Set from URL params on mount, or whenever the URL changes externally. */
  hydrate(params: URLSearchParams) {
    this.nav = parseNav(params.get('nav'));
    this.id = params.get('id');
    this.q = params.get('q') ?? '';
    const entity = params.get('entity');
    this.entity = entity === 'releases' || entity === 'tracks' ? entity : null;
  }

  /** Serialize current state to URLSearchParams. Omits empty/default values. */
  serialize(): URLSearchParams {
    const params = new URLSearchParams();
    if (navToString(this.nav) !== navToString(DEFAULT_NAV)) {
      params.set('nav', navToString(this.nav));
    }
    if (this.id) params.set('id', this.id);
    if (this.q) params.set('q', this.q);
    if (this.entity) params.set('entity', this.entity);
    return params;
  }

  /** Set rail item; clears entity selection (different rail = different list). */
  setNav(nav: NavValue) {
    this.nav = nav;
    this.id = null;
    // ?entity is only meaningful when the new rail item allows both kinds.
    // Clearing it on every nav change lets currentEntity fall back to the
    // rail item's default (e.g. Discogs → releases).
    this.entity = null;
    // Don't clear q — user may want to refine across rails. Reconsider if it feels wrong.
  }

  setEntity(id: string | null) {
    this.id = id;
  }

  setQuery(q: string) {
    this.q = q;
  }

  setEntityKind(entity: EntityKind | null) {
    this.entity = entity;
  }
}

export const explorerState = new ExplorerState();
