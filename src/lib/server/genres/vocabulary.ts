import { matchKey } from '../library/relink';
import { GENRES } from '../../genres';

/**
 * Discogs' styles, one line per parent genre so they read as data. A style
 * under two genres appears in both lines. Styles missing here are learned from
 * synced Discogs releases (see `loadVocabulary`), so this need not be complete.
 */
const STYLES: Record<string, string> = {
  Electronic: 'Abstract|Acid|Acid House|Acid Jazz|Afro House|Ambient|Balearic|Baltimore Club|Bass Music|Bassline|Beatdown|Berlin-School|Big Beat|Bleep|Breakbeat|Breakcore|Breaks|Broken Beat|Chillwave|Chiptune|Dance-pop|Dark Ambient|Darkwave|Deep House|Deep Techno|Disco|Downtempo|Drone|Drum n Bass|Dub|Dub Techno|Dubstep|EBM|Electro|Electro House|Electroclash|Euro House|Euro-Disco|Eurodance|Experimental|Footwork|Freestyle|Future Jazz|Gabber|Garage House|Ghetto House|Glitch|Goa Trance|Gqom|Grime|Halftime|Happy Hardcore|Hard House|Hard Techno|Hard Trance|Hardcore|Hardstyle|Hi NRG|Hip-House|House|IDM|Illbient|Industrial|Italo House|Italo-Disco|Jersey Club|Juke|Jungle|Kuduro|Leftfield|Lo-Fi|Minimal|Minimal Techno|Modern Classical|Musique Concrète|New Age|New Beat|New Wave|Noise|Nu-Disco|Progressive Breaks|Progressive House|Progressive Trance|Psy-Trance|Schranz|Sound Collage|Speed Garage|Synth-pop|Synthwave|Tech House|Tech Trance|Techno|Trance|Tribal|Tribal House|Trip Hop|Tropical House|UK Funky|UK Garage|Vaporwave|Witch House',
  'Funk / Soul': 'Afrobeat|Boogie|Contemporary R&B|Disco|Funk|Gogo|Gospel|Minneapolis Sound|Neo Soul|New Jack Swing|Northern Soul|P.Funk|Psychedelic|Rhythm & Blues|Soul|Swingbeat|UK Street Soul',
  'Hip Hop': 'Boom Bap|Bounce|Cloud Rap|Conscious|Crunk|Cut-up/DJ|Drill|G-Funk|Gangsta|Hardcore Hip-Hop|Instrumental|Jazzy Hip-Hop|Miami Bass|Pop Rap|Ragga HipHop|RnB/Swing|Screw|Trap|Turntablism',
  Jazz: 'Acid Jazz|Afro-Cuban Jazz|Avant-garde Jazz|Big Band|Bop|Bossa Nova|Contemporary Jazz|Cool Jazz|Easy Listening|Free Funk|Free Improvisation|Free Jazz|Fusion|Hard Bop|Jazz-Funk|Jazz-Rock|Latin Jazz|Modal|Post Bop|Smooth Jazz|Soul-Jazz|Spiritual Jazz|Swing',
  Rock: 'Alternative Rock|Art Rock|Blues Rock|Classic Rock|Coldwave|Dream Pop|Emo|Folk Rock|Garage Rock|Glam|Goth Rock|Grunge|Hard Rock|Heavy Metal|Indie Rock|Krautrock|Lo-Fi|Math Rock|Mod|New Wave|No Wave|Noise|Pop Rock|Post Rock|Post-Punk|Prog Rock|Psychedelic Rock|Punk|Rock & Roll|Shoegaze|Soft Rock|Space Rock|Surf',
  Pop: 'Ballad|Bubblegum|Chanson|City Pop|Dream Pop|Europop|Indie Pop|J-pop|K-pop|Kayōkyoku|Light Music|Novelty|Schlager|Synth-pop|Vocal',
  'Folk, World, & Country': 'African|Bluegrass|Celtic|Country|Fado|Flamenco|Folk|Highlife|Juju|Kwaito|Mbalax|Soukous|Zouk',
  Latin: 'Afro-Cuban|Bachata|Baião|Batucada|Bolero|Boogaloo|Bossanova|Cha-Cha|Cumbia|Descarga|Forró|Guaguancó|Latin Jazz|Mambo|Merengue|MPB|Reggaeton|Rumba|Salsa|Samba|Son|Tango|Tropical',
  Reggae: 'Calypso|Dancehall|Dub|Lovers Rock|Ragga|Reggae|Rocksteady|Roots Reggae|Ska|Soca',
  Blues: 'Boogie Woogie|Chicago Blues|Country Blues|Delta Blues|Electric Blues|Jump Blues|Piano Blues|Rhythm & Blues|Texas Blues',
  Classical: 'Baroque|Choral|Contemporary|Impressionist|Medieval|Modern|Neo-Classical|Neo-Romantic|Opera|Post-Modern|Renaissance|Romantic',
  'Stage & Screen': 'Musical|Score|Soundtrack|Theme',
  'Non-Music': 'Comedy|Field Recording|Interview|Poetry|Radioplay|Sound Art|Speech|Spoken Word',
  "Children's": 'Educational|Nursery Rhymes|Story',
  'Brass & Military': 'Brass Band|Marches|Military',
};

/**
 * Terms that name a *genre*, checked before styles. "hip hop" is also an
 * Electronic style in Discogs; a Bandcamp tag "hip-hop" means the genre.
 */
const GENRE_ALIASES: Record<string, string> = {
  electronic: 'Electronic', electronica: 'Electronic',
  rock: 'Rock',
  funk: 'Funk / Soul', soul: 'Funk / Soul', funksoul: 'Funk / Soul', rb: 'Funk / Soul', rnb: 'Funk / Soul', rbsoul: 'Funk / Soul',
  jazz: 'Jazz',
  hiphop: 'Hip Hop', rap: 'Hip Hop', hiphoprap: 'Hip Hop',
  pop: 'Pop',
  latin: 'Latin', reggae: 'Reggae', blues: 'Blues', classical: 'Classical',
  soundtrack: 'Stage & Screen',
};

/** Spellings Bandcamp and stores use for a Discogs style that normalisation alone can't bridge. */
const STYLE_ALIASES: Record<string, string> = {
  drumandbass: 'Drum n Bass', drumbass: 'Drum n Bass', dnb: 'Drum n Bass',
  ukg: 'UK Garage', housemusic: 'House', italodisco: 'Italo-Disco',
  psytrance: 'Psy-Trance', triphop: 'Trip Hop', dubtechno: 'Dub Techno',
};

/** Bandcamp's primary genre (`norm_name`) → Discogs genre. Unlisted → null. */
const BANDCAMP_GENRES: Record<string, string> = {
  electronic: 'Electronic', rock: 'Rock', metal: 'Rock', alternative: 'Rock', punk: 'Rock',
  'hip-hop-rap': 'Hip Hop', pop: 'Pop', jazz: 'Jazz', funk: 'Funk / Soul', 'r-b-soul': 'Funk / Soul',
  folk: 'Folk, World, & Country', world: 'Folk, World, & Country', country: 'Folk, World, & Country',
  soundtrack: 'Stage & Screen', classical: 'Classical', reggae: 'Reggae', blues: 'Blues', latin: 'Latin',
  'spoken-word': 'Non-Music', comedy: 'Non-Music', podcasts: 'Non-Music', audiobooks: 'Non-Music',
};

export interface Vocabulary {
  parents: Map<string, string[]>;
  byKey: Map<string, string>;
}

export function staticVocabulary(): Vocabulary {
  const v: Vocabulary = { parents: new Map(), byKey: new Map() };
  for (const [genre, line] of Object.entries(STYLES)) {
    for (const style of line.split('|')) extendVocabulary(v, style, [genre]);
  }
  return v;
}

export function extendVocabulary(v: Vocabulary, style: string, parents: string[]): void {
  const prev = v.parents.get(style) ?? [];
  v.parents.set(style, [...new Set([...prev, ...parents])]);
  v.byKey.set(matchKey(style), style);
}

const GENRE_KEYS = new Map<string, string>(GENRES.map((g) => [matchKey(g), g]));

/**
 * Map free-form terms (Bandcamp tags, file-tag fragments) into the vocabulary.
 * Anything that is neither a genre nor a known style is dropped — this is what
 * filters out artist names, cities and jokes without a blocklist.
 */
export function mapTerms(terms: string[], v: Vocabulary): { genres: string[]; styles: string[] } {
  const genres = new Set<string>();
  const styles = new Set<string>();
  for (const term of terms) {
    const k = matchKey(term);
    if (!k) continue;
    const g = GENRE_KEYS.get(k) ?? GENRE_ALIASES[k];
    if (g) { genres.add(g); continue; }
    const s = v.byKey.get(k) ?? STYLE_ALIASES[k];
    if (s) styles.add(s);
  }
  return { genres: [...genres], styles: [...styles] };
}

/**
 * A file's genre tag, as candidate terms: the whole value, the value without
 * bracketed groups, and its parts split on , / ; | and spaced &. Splitting on a
 * bare & would turn "R&B" into "R" and "B".
 */
export function splitFileGenre(raw: string): string[] {
  const whole = raw.trim();
  const unbracketed = whole.replace(/\s*[([][^)\]]*[)\]]/g, '').trim();
  const parts = unbracketed.split(/\s*(?:[,/;|]|\s&\s|\s-\s)\s*/).map((p) => p.trim()).filter(Boolean);
  return [...new Set([whole, unbracketed, ...parts].filter(Boolean))];
}

export function mapBandcampGenre(norm: string): string | null {
  return BANDCAMP_GENRES[norm] ?? null;
}

/** Explicit genres win; only when there are none do styles imply them through their parents. */
export function inferGenres(explicit: string[], styles: string[], v: Vocabulary): string[] {
  if (explicit.length) return [...new Set(explicit)];
  const out = new Set<string>();
  for (const s of styles) for (const p of v.parents.get(s) ?? []) out.add(p);
  return [...out];
}
