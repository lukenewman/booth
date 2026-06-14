/**
 * Mirror of the explorer's URL state. The Explorer.svelte shell keeps URL ↔
 * store sync; child components read from this store.
 *
 * URL params: ?nav=<section>:<item>, ?id=<entityId>, ?q=<query>, ?entity=<releases|tracks>
 *
 * `?entity` is an app-wide viewing lens, not a per-rail attribute — it persists
 * across rail switches and is toggled by the Tab key.
 */

export type NavSection = 'library' | 'sources' | 'add' | 'playlist';
export interface NavValue { section: NavSection; item: string; }

export type EntityKind = 'releases' | 'tracks' | 'artists';

const ENTITY_CYCLE: EntityKind[] = ['releases', 'tracks', 'artists'];

const DEFAULT_NAV: NavValue = { section: 'library', item: 'all' };

/**
 * Parse a `?nav=section:item` value. Old `library:all-releases` /
 * `library:all-tracks` URLs redirect to the consolidated `library:all` item
 * and carry their entity-kind forward via the returned `entityHint`.
 */
export function parseNav(raw: string | null): { nav: NavValue; entityHint: EntityKind | null } {
  if (!raw) return { nav: { ...DEFAULT_NAV }, entityHint: null };
  const [section, item] = raw.split(':');
  if (section !== 'library' && section !== 'sources' && section !== 'add' && section !== 'playlist') {
    return { nav: { ...DEFAULT_NAV }, entityHint: null };
  }
  if (!item) return { nav: { ...DEFAULT_NAV }, entityHint: null };
  if (section === 'library' && item === 'all-releases') {
    return { nav: { section: 'library', item: 'all' }, entityHint: 'releases' };
  }
  if (section === 'library' && item === 'all-tracks') {
    return { nav: { section: 'library', item: 'all' }, entityHint: 'tracks' };
  }
  return { nav: { section, item }, entityHint: null };
}

export function navToString(nav: NavValue): string {
  return `${nav.section}:${nav.item}`;
}

class ExplorerState {
  nav = $state<NavValue>({ ...DEFAULT_NAV });
  id = $state<string | null>(null);
  q = $state<string>('');
  entity = $state<EntityKind>('releases');

  hydrate(params: URLSearchParams) {
    const parsed = parseNav(params.get('nav'));
    this.nav = parsed.nav;
    this.id = params.get('id');
    this.q = params.get('q') ?? '';
    const entity = params.get('entity');
    if (entity === 'releases' || entity === 'tracks' || entity === 'artists') {
      this.entity = entity;
    } else if (parsed.entityHint) {
      this.entity = parsed.entityHint;
    }
  }

  /** Serialize current state to URLSearchParams. Omits empty/default values. */
  serialize(): URLSearchParams {
    const params = new URLSearchParams();
    if (navToString(this.nav) !== navToString(DEFAULT_NAV)) {
      params.set('nav', navToString(this.nav));
    }
    if (this.id) params.set('id', this.id);
    if (this.q) params.set('q', this.q);
    if (this.entity !== 'releases') params.set('entity', this.entity);
    return params;
  }

  /**
   * Switch rail item. Clears the selected entity (different rail = different
   * list, so the old id rarely makes sense). Crucially does NOT touch
   * `entity` — the tracks/releases lens is app-wide, so it persists across
   * rail switches.
   */
  setNav(nav: NavValue) {
    this.nav = nav;
    this.id = null;
  }

  setEntity(id: string | null) {
    this.id = id;
  }

  setQuery(q: string) {
    this.q = q;
  }

  setEntityKind(entity: EntityKind) {
    this.entity = entity;
  }

  toggleEntityKind() {
    const i = ENTITY_CYCLE.indexOf(this.entity);
    this.entity = ENTITY_CYCLE[(i + 1) % ENTITY_CYCLE.length];
  }
}

export const explorerState = new ExplorerState();
