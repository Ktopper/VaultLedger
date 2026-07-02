import { expect, test } from "vitest";
import { run } from "../src/index.js";
test("cli run returns 0", () => { expect(run()).toBe(0); });
