import { expect, test } from "vitest";
import { listToolNames } from "../src/index.js";
test("mcp-server lists 12 tool names", () => { expect(listToolNames()).toHaveLength(12); });
