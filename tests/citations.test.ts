import { describe, expect, it } from "vitest";
import { processCitations, extractCitationIds } from "@/lib/citations";

const known = new Set(["S1", "S2", "S7"]);
const isKnown = (id: string) => known.has(id);

describe("processCitations", () => {
  it("renumbers ids in order of first appearance", () => {
    const r = processCitations("A was written by X [S7]. B is older [S1]. A again [S7].", isKnown);
    expect(r.order).toEqual(["S7", "S1"]);
    expect(r.markdown).toBe("A was written by X [1](#cite-S7). B is older [2](#cite-S1). A again [1](#cite-S7).");
  });

  it("expands grouped citations", () => {
    const r = processCitations("Both are fantasy [S1, S2].", isKnown);
    expect(r.markdown).toBe("Both are fantasy [1](#cite-S1)[2](#cite-S2).");
  });

  it("drops ids that are not in the registry (no invented sources)", () => {
    const r = processCitations("Made up [S99]. Real [S2].", isKnown);
    expect(r.invalid).toEqual(["S99"]);
    expect(r.markdown).toBe("Made up. Real [1](#cite-S2).");
  });

  it("hides a half-streamed marker at the end", () => {
    expect(processCitations("Published in 1979 [S", isKnown, { streaming: true }).markdown).toBe("Published in 1979 ");
    expect(processCitations("Published in 1979 [S1, S", isKnown, { streaming: true }).markdown).toBe("Published in 1979 ");
  });

  it("leaves normal brackets alone", () => {
    expect(processCitations("See [this](https://x.y) [note]", isKnown).markdown).toBe("See [this](https://x.y) [note]");
  });

  it("extracts cited ids", () => {
    expect(extractCitationIds("x [S1] y [S2; s3]")).toEqual(["S1", "S2", "S3"]);
  });
});
