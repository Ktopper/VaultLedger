import { describe, expect, test } from "vitest";
import { Readable } from "node:stream";
import { promptYesNo } from "../src/prompt.js";

describe("promptYesNo", () => {
  test('"y\\n" resolves true', async () => {
    const result = await promptYesNo("Continue?", { input: Readable.from(["y\n"]), out: () => {} });
    expect(result).toBe(true);
  });

  test('"yes\\n" resolves true', async () => {
    const result = await promptYesNo("Continue?", { input: Readable.from(["yes\n"]), out: () => {} });
    expect(result).toBe(true);
  });

  test('empty line resolves false', async () => {
    const result = await promptYesNo("Continue?", { input: Readable.from(["\n"]), out: () => {} });
    expect(result).toBe(false);
  });

  test('"no\\n" resolves false', async () => {
    const result = await promptYesNo("Continue?", { input: Readable.from(["no\n"]), out: () => {} });
    expect(result).toBe(false);
  });

  test("EOF with no line resolves false", async () => {
    const result = await promptYesNo("Continue?", { input: Readable.from([]), out: () => {} });
    expect(result).toBe(false);
  });

  test("writes the question with a [y/N] suffix to out", async () => {
    const messages: string[] = [];
    await promptYesNo("Write this?", { input: Readable.from(["y\n"]), out: (s) => messages.push(s) });
    expect(messages).toEqual(["Write this? [y/N] "]);
  });
});
