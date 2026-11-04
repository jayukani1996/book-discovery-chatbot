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

export function processCitations(text: string, isKnown: (id: string) => boolean, opts: { streaming?: boolean } = {}): CitationResult {
  const order: string[] = [];
  const invalid: string[] = [];
  let src = text;
  if (opts.streaming) src = src.replace(PARTIAL_TAIL_RE, "");

  const markdown = src.replace(CITE_RE, (_m, group: string) => {
    const ids = group.split(/[,;]/).map((s) => s.trim().toUpperCase());
    const parts: string[] = [];
    for (const id of ids) {
      if (!isKnown(id)) {
        if (!invalid.includes(id)) invalid.push(id);
        continue;
      }
      let n = order.indexOf(id);
      if (n === -1) {
        order.push(id);
        n = order.length - 1;
      }
      parts.push(`[${n + 1}](#cite-${id})`);
    }
    return parts.length ? parts.join("") : "\u0000";
  }).replace(/[ \t]*\u0000/g, "");

  return { markdown, order, invalid };
}

/** Ids cited in a raw model answer (used server-side for logging/validation). */
export function extractCitationIds(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(CITE_RE)) for (const id of m[1].split(/[,;]/)) out.add(id.trim().toUpperCase());
  return [...out];
}
