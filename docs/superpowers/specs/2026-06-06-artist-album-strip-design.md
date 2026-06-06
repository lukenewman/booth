# Artist Album Strip

Add a scrollable album thumbnail strip to each row in the Artist list view.

## What it does

Every artist row gains a dedicated "Albums" column showing a horizontal strip of that artist's release covers. Each cover is a 36×36 px square — a real `<img>` when the release has a `thumb_url`, a grey placeholder when it doesn't. A short album title is truncated below each cover. Artists with more albums than fit in the 160 px column width can be browsed by scrolling horizontally (trackpad swipe / mouse wheel tilt) — no arrows, no chrome.

## Data layer

`listArtists` (`src/lib/server/library/queries.ts`) adds a third pass after the existing artist rows + source-map passes:

```sql
SELECT artist_id, title, thumb_url
FROM release
WHERE artist_id IN (<page ids>)
ORDER BY year ASC NULLS LAST, title ASC COLLATE NOCASE
```

Results are grouped into a `Map<artistId, { title: string; thumbUrl: string | null }[]>` and merged onto each row. No server-side cap — a personal library is small enough that returning all releases for the current artist page is fine.

`ArtistListItem` gains:

```ts
albums: { title: string; thumbUrl: string | null }[];
```

The `/api/library/artists` route requires no change — it already serialises whatever `listArtists` returns.

## UI layer (`ArtistList.svelte`)

**Grid:** `1fr 44px 44px 56px` → `1fr 160px 44px 44px 56px`. Header gains an "Albums" label in the new slot.

**Strip markup per row:**

```html
<div class="album-strip">
  {#each item.albums as album}
    <div class="album-item">
      {#if album.thumbUrl}
        <img src={album.thumbUrl} alt={album.title} class="cover" />
      {:else}
        <div class="cover placeholder"></div>
      {/if}
      <span class="album-title">{album.title}</span>
    </div>
  {/each}
</div>
```

**Key CSS:**

```css
.album-strip {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  scrollbar-width: none;
}
.album-strip::-webkit-scrollbar { display: none; }

.album-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  width: 36px;
}

.cover {
  width: 36px;
  height: 36px;
  border-radius: 3px;
  object-fit: cover;
}
.placeholder {
  background: #252525;
}

.album-title {
  font-size: 8px;
  color: var(--text-subtle);
  width: 36px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  line-height: 1.2;
}
```

**Click behaviour:** unchanged. The strip is a non-interactive `div`; clicks bubble to the row's `onSelect` handler as before.

## What doesn't change

- `ArtistDetail.svelte` — no changes
- `/api/library/artists/[id]/+server.ts` — no changes
- Pagination, search, source filtering — no changes
- `ReleaseList.svelte`, `TrackList.svelte` — no changes
