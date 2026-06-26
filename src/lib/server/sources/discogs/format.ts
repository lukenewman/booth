// One entry in a Discogs result's `formats` array. The `text` free-text field
// (e.g. "Clear, 180g") and `descriptions` carry the color/weight/pressing detail
// that the flattened `format` array omits.
export interface DiscogsFormat {
  name?: string;
  qty?: string;
  text?: string;
  descriptions?: string[];
}

/**
 * Build a human format string from a Discogs result's rich `formats[]`, e.g.
 * "Vinyl, LP, Album, Clear, 180g". Each format object contributes
 * `[qty×]name, …descriptions, …text-parts`; multiple objects join with " / ".
 * Returns null when there's nothing usable so callers can fall back to the
 * flattened `format` array.
 */
export function buildFormatLabel(formats: DiscogsFormat[] | undefined | null): string | null {
  if (!formats?.length) return null;

  const labels = formats
    .map((f) => {
      const parts: string[] = [];
      if (f.name) {
        const qty = f.qty && f.qty !== '1' ? `${f.qty}×` : '';
        parts.push(`${qty}${f.name}`);
      }
      for (const d of f.descriptions ?? []) {
        if (d?.trim()) parts.push(d.trim());
      }
      for (const t of (f.text ?? '').split(',')) {
        if (t.trim()) parts.push(t.trim());
      }
      return parts.join(', ');
    })
    .filter(Boolean);

  return labels.length ? labels.join(' / ') : null;
}
