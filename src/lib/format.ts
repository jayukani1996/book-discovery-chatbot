import type { BookSource } from "./types";

export const hasCover = (s: Pick<BookSource, "coverId" | "coverImage">) => !!(s.coverId || s.coverImage);

/**
 * Open Library's search index (`first_publish_year`) and the work record
 * (`first_publish_date`) sometimes disagree, e.g. Chamber of Secrets: 1998 vs "1999".
 * Use the work-record date only when it is consistent with the search year
 * (e.g. "June 1979" for 1979), so the answer text and the citation preview
 * never show two different dates for the same fact.
 */
export function consistentPublishDate(s: Pick<BookSource, "firstPublishYear" | "firstPublishDate">): string | undefined {
  const date = s.firstPublishDate?.trim();
  if (!s.firstPublishYear) return date || undefined;
  if (date && date.includes(String(s.firstPublishYear))) return date;
  return String(s.firstPublishYear);
}
