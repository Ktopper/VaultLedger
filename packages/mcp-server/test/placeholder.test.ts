import { expect, test } from "vitest";
import { listToolNames } from "../src/index.js";
test("mcp-server lists 8 tool names", () => { expect(listToolNames()).toHaveLength(8); });
