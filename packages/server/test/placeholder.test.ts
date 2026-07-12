import { expect, test } from "vitest";
import { VERSION } from "../src/index.js";
test("server exposes version", () => { expect(VERSION).toBe("0.4.0"); });
