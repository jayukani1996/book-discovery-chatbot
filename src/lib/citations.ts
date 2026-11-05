/**
 * Citation handling (shared by server tests and the client renderer).
 *
 * The model cites records with their registry ids, e.g. "... in 1979. [S3]"
 * or "[S3, S5]". Before rendering we:
 *   1. drop any id that is not in the registry (the model cannot invent a source),
 *   2. renumber the valid ids per message in order of first appearance -> [1], [2],
 *   3. emit markdown links "#cite-S3" that the renderer turns into hover previews.
 */

const CITE_RE = /\[\s*(S\d+(?:\s*[,;]\s*S\d+)*)\s*\]/gi;
const PARTIAL_TAIL_RE = /\[\s*(?:S\d*(?:\s*[,;]\s*S?\d*)*)?\s*$/i;

export interface CitationResult {
  markdown: string;
  /** Ordered list of cited source ids; index + 1 is the displayed number. */
  order: string[];
  /** Ids the model used that do not exist in the registry. */
  invalid: string[];
}

/** One or more adjacent citation brackets: "[S1]", "[S1, S2]", "[S1][S2] [S3]". */
const RUN_RE = /\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\](?:[ \t]*\[\s*S\d+(?:\s*[,;]\s*S\d+)*\s*\])*/gi;
/** More markers than this in one spot is clutter: show the first few, then "+N". */
export const MAX_MARKERS_PER_SPOT = 3;

export function processCitations(text: string, isKnown: (id: string) => boolean, opts: { streaming?: boolean } = {}): CitationResult {
  const order: string[] = [];
  const invalid: string[] = [];
  // Never render an echoed internal display note.
  let src = text.replace(/\n*\[?(?:App note: book cards displayed|Books displayed to the user)[^\n]*\]?\s*$/i, "");
  if (opts.streaming) src = src.replace(PARTIAL_TAIL_RE, "");

  const idsOf = (run: string) => {
    const ids: string[] = [];
    for (const m of run.matchAll(CITE_RE))
      for (const raw of m[1].split(/[,;]/)) {
        const id = raw.trim().toUpperCase();
        if (!isKnown(id)) {
          if (!invalid.includes(id)) invalid.push(id);
        } else if (!ids.includes(id)) ids.push(id);
      }
    return ids;
  };

  // Ids that are cited somewhere in a small, specific spot (e.g. their own list item).
  const citedSpecifically = new Set<string>();
  for (const m of src.matchAll(RUN_RE)) {
    const ids = idsOf(m[0]);
    if (ids.length <= MAX_MARKERS_PER_SPOT) ids.forEach((id) => citedSpecifically.add(id));
  }
  invalid.length = 0;

  const markdown = src
    .replace(RUN_RE, (run) => {
      let ids = idsOf(run);
      if (ids.length > MAX_MARKERS_PER_SPOT) {
        // A blanket cluster ("Here are books by X [S1]…[S10]") adds nothing when each book is cited on its own line.
        if (ids.every((id) => citedSpecifically.has(id))) return "\u0000";
      }
      const extra = Math.max(0, ids.length - MAX_MARKERS_PER_SPOT);
      ids = ids.slice(0, MAX_MARKERS_PER_SPOT);
      const parts = ids.map((id) => {
        let n = order.indexOf(id);
        if (n === -1) {
          order.push(id);
          n = order.length - 1;
        }
        return `[${n + 1}](#cite-${id})`;
      });
      if (extra) parts.push(`[+${extra}](#cite-more)`);
      return parts.length ? parts.join("") : "\u0000";
    })
    .replace(/[ \t]*\u0000/g, "");

  return { markdown, order, invalid };
}

/** Ids cited in a raw model answer (used server-side for logging/validation). */
export function extractCitationIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CITE_RE)) for (const id of m[1].split(/[,;]/)) out.add(id.trim().toUpperCase());
  return [...out];
}
