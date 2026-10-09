/**
 * Genre/style filter shared by the client (URL + list requests) and the server
 * (query params). Includes are any-of; excludes only ever match tagged
 * releases (see genreWhere).
 */
export interface GenreFilter {
  genres?: { include: string[]; exclude: string[] };
  styles?: { include: string[]; exclude: string[] };
  untagged?: boolean;
}

// Repeated params, never comma-joined: "Folk, World, & Country" is one genre.
function split(values: string[]) {
  return {
    include: values.filter((v) => !v.startsWith('-')),
    exclude: values.filter((v) => v.startsWith('-')).map((v) => v.slice(1)),
  };
}

export function parseGenreFilter(params: URLSearchParams): GenreFilter {
  const f: GenreFilter = {};
  const g = params.getAll('genre');
  const s = params.getAll('style');
  if (g.length) f.genres = split(g);
  if (s.length) f.styles = split(s);
  if (params.get('untagged') === '1') f.untagged = true;
  return f;
}

export function genreFilterToParams(f: GenreFilter, params: URLSearchParams): void {
  for (const v of f.genres?.include ?? []) params.append('genre', v);
  for (const v of f.genres?.exclude ?? []) params.append('genre', `-${v}`);
  for (const v of f.styles?.include ?? []) params.append('style', v);
  for (const v of f.styles?.exclude ?? []) params.append('style', `-${v}`);
  if (f.untagged) params.set('untagged', '1');
}

export function isEmptyGenreFilter(f: GenreFilter): boolean {
  return (
    !f.untagged &&
    !f.genres?.include.length && !f.genres?.exclude.length &&
    !f.styles?.include.length && !f.styles?.exclude.length
  );
}
