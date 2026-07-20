import { expect, test } from "vitest";
import { listToolNames } from "../src/index.js";
test("mcp-server lists 15 default tool names", () => { expect(listToolNames()).toHaveLength(15); });
test("mcp-server lists 16 tool names with --allow-raw-diff", () => { expect(listToolNames(true)).toHaveLength(16); });
