import { expect, it } from "vitest";
import { rateLimit } from "../src/lib/rateLimit";

it("allows 20 requests per minute per IP, then asks the client to wait", () => {
  const t = 1_000_000;
  for (let i = 0; i < 20; i++) expect(rateLimit("1.2.3.4", t + i).ok).toBe(true);
  const blocked = rateLimit("1.2.3.4", t + 30);
  expect(blocked.ok).toBe(false);
  expect(blocked.retryAfterSec).toBeGreaterThan(0);
  expect(rateLimit("5.6.7.8", t + 30).ok).toBe(true); // other users unaffected
  expect(rateLimit("1.2.3.4", t + 61_000).ok).toBe(true); // window slides
});
