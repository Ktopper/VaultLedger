import { expect, test } from "vitest";
import { listToolNames } from "../src/index.js";
test("mcp-server lists 7 tool names", () => { expect(listToolNames()).toHaveLength(7); });
