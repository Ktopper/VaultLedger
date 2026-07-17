import { expect, test } from "vitest";
import { listToolNames } from "../src/index.js";
test("mcp-server lists 11 tool names", () => { expect(listToolNames()).toHaveLength(11); });
