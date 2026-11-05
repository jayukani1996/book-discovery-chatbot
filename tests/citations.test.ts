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

  it("drops a blanket cluster when every id is already cited on its own", () => {
    const k = (id: string) => /^S[1-5]$/.test(id);
    const r = processCitations("Books by X [S1][S2][S3][S4]:\n- A [S1]\n- B [S2]\n- C [S3]\n- D [S4]", k);
    expect(r.markdown).toBe("Books by X:\n- A [1](#cite-S1)\n- B [2](#cite-S2)\n- C [3](#cite-S3)\n- D [4](#cite-S4)");
  });

  it("caps an uncovered cluster at three markers plus a count", () => {
    const k = (id: string) => /^S[1-5]$/.test(id);
    const r = processCitations("None of these list sales [S1][S2] [S3, S4, S5].", k);
    expect(r.markdown).toBe("None of these list sales [1](#cite-S1)[2](#cite-S2)[3](#cite-S3)[+2](#cite-more).");
  });

  it("extracts cited ids", () => {
    expect(extractCitationIds("x [S1] y [S2; s3]")).toEqual(["S1", "S2", "S3"]);
  });
});
