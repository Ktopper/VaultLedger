import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
test("core exposes version", () => { expect(VERSION).toBe("0.4.7"); });
