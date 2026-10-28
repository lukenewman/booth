<script lang="ts">
  /**
   * The one way to show a release's detail. Everything that comes from the
   * release payload (tracks, notes, identifiers, genres, styles…) is filled in
   * here, so a feature added to the payload reaches every place a release is
   * shown — the library pane, a playlist's or gig's link pane, and mobile.
   * Callers pass only what genuinely differs by context: the actions.
   *
   * A Discogs search hit is not a library release yet, so library-only actions
   * (vet, tag, record, cover, tap tempo) are dropped for it here rather than at each call site.
   */
  import type { ComponentProps } from 'svelte';
  import ReleaseDetail from './ReleaseDetail.svelte';

  type FromPayload = 'release' | 'sources' | 'tracks' | 'notes' | 'identifiers' | 'genres' | 'styles' | 'genreOrigin';
  type Actions = Omit<ComponentProps<typeof ReleaseDetail>, FromPayload>;

  // The detail endpoints' payload (and the Add view's search-hit stand-in).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let { data, ...actions }: { data: any } & Actions = $props();

  const searchHit = $derived(!!data._isDiscogsSearchHit);
</script>

<ReleaseDetail
  release={data.release}
  sources={data.sources}
  tracks={data.tracks ?? []}
  notes={data.notes ?? null}
  identifiers={data.identifiers ?? []}
  genres={data.genres ?? []}
  styles={data.styles ?? []}
  genreOrigin={data.genreOrigin ?? null}
  {...actions}
  onVet={searchHit ? undefined : actions.onVet}
  onSaveTags={searchHit ? undefined : actions.onSaveTags}
  onRecord={searchHit ? undefined : actions.onRecord}
  onSetCover={searchHit ? undefined : actions.onSetCover}
  tappable={searchHit ? false : actions.tappable}
/>
