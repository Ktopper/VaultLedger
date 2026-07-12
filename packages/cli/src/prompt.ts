import { createInterface } from "node:readline";

export interface PromptDeps {
  input?: NodeJS.ReadableStream; // default process.stdin — injectable for tests
  out?: (s: string) => void; // default process.stdout write
}

/** One-line y/N prompt. Default is NO (empty line / EOF / anything but y|yes
 * => false) — the safe default for a write confirmation. */
export async function promptYesNo(question: string, deps: PromptDeps = {}): Promise<boolean> {
  const input = deps.input ?? process.stdin;
  const out = deps.out ?? ((s: string) => process.stdout.write(s));
  out(`${question} [y/N] `);
  const rl = createInterface({ input, terminal: false });
  try {
    const line: string = await new Promise((resolve) => {
      rl.once("line", (l) => resolve(l));
      rl.once("close", () => resolve("")); // EOF => "" => No
    });
    return /^\s*y(es)?\s*$/i.test(line);
  } finally {
    rl.close();
  }
}
