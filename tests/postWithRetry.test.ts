import { describe, expect, it } from "vitest";
import { AnswerStalledError, postWithRetry, readOrStall } from "@/lib/postWithRetry";

const ok = () => new Response("ok");

describe("postWithRetry", () => {
  it("retries once after a dropped connection", async () => {
    let calls = 0;
    const f = (async () => {
      if (++calls === 1) throw new TypeError("failed");
      return ok();
    }) as unknown as typeof fetch;
    expect((await postWithRetry("/x", {}, f)).ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("reports a network error when both attempts fail", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      throw new TypeError("failed");
    }) as unknown as typeof fetch;
    await expect(postWithRetry("/x", {}, f)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(2);
  });

  it("retries when the server never starts responding, and reports it as a network error", async () => {
    let calls = 0;
    const f = ((_: string, init: RequestInit) => {
      calls++;
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    await expect(postWithRetry("/x", {}, f, 20)).rejects.toBeInstanceOf(TypeError);
    expect(calls).toBe(2);
  });

  it("does not retry when the user pressed Stop", async () => {
    let calls = 0;
    const user = new AbortController();
    const f = ((_: string, init: RequestInit) => {
      calls++;
      return new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }) as unknown as typeof fetch;
    const pending = postWithRetry("/x", { signal: user.signal }, f);
    user.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(calls).toBe(1);
  });

  it("does not retry a server error", async () => {
    let calls = 0;
    const f = (async () => {
      calls++;
      return new Response("nope", { status: 500 });
    }) as unknown as typeof fetch;
    expect((await postWithRetry("/x", {}, f)).status).toBe(500);
    expect(calls).toBe(1);
  });

  it("lets Stop cancel the answer after it has started", async () => {
    const user = new AbortController();
    let seen: AbortSignal | undefined;
    const f = (async (_: string, init: RequestInit) => {
      seen = init.signal!;
      return ok();
    }) as unknown as typeof fetch;
    await postWithRetry("/x", { signal: user.signal }, f);
    user.abort();
    expect(seen?.aborted).toBe(true);
  });
});

describe("readOrStall", () => {
  it("returns a chunk that arrives in time", async () => {
    await expect(readOrStall({ read: async () => "chunk" }, 50)).resolves.toBe("chunk");
  });

  it("gives up on a stream that silently stops delivering", async () => {
    await expect(readOrStall({ read: () => new Promise(() => {}) }, 20)).rejects.toBeInstanceOf(AnswerStalledError);
  });

  it("passes on a real read error", async () => {
    await expect(readOrStall({ read: async () => { throw new TypeError("dropped"); } }, 50)).rejects.toBeInstanceOf(TypeError);
  });
});

