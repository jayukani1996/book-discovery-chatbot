import { describe, expect, it } from "vitest";
import { consistentPublishDate } from "../src/lib/format";

describe("consistentPublishDate", () => {
  it("keeps a detailed work date that matches the search year", () => {
    expect(consistentPublishDate({ firstPublishYear: 1979, firstPublishDate: "June 1979" })).toBe("June 1979");
  });
  it("falls back to the search year when the work record disagrees", () => {
    expect(consistentPublishDate({ firstPublishYear: 1998, firstPublishDate: "1999" })).toBe("1998");
  });
  it("handles missing values", () => {
    expect(consistentPublishDate({ firstPublishDate: "1969" })).toBe("1969");
    expect(consistentPublishDate({})).toBeUndefined();
  });
});
