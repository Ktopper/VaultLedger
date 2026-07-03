import { describe, expect, test } from "vitest";
import { openJournal } from "../../src/journal/db.js";
import {
  Journal,
  type TransactionRow,
  type MemoryRow,
  type ApprovalRow,
} from "../../src/journal/journal.js";

function makeJournal(): Journal {
  const db = openJournal(":memory:");
  return new Journal(db);
}

describe("openJournal", () => {
  test("creates schema idempotently (open + DDL run twice without error)", () => {
    const db1 = openJournal(":memory:");
    expect(() => new Journal(db1)).not.toThrow();

    // Re-running the DDL against a fresh in-memory db should also be fine
    // (CREATE TABLE IF NOT EXISTS), and opening a second db independently
    // should not throw either.
    const db2 = openJournal(":memory:");
    expect(() => new Journal(db2)).not.toThrow();

    // Exercise the tables exist by inserting a trivial row into each.
    const j = new Journal(db1);
    expect(j.listTransactions({})).toEqual([]);
  });

  test("DB enforces NOT NULL on required transaction columns", () => {
    const j = makeJournal();
    // A row with a null required field (status) must be rejected at the DB level.
    const badRow = {
      id: "tx_bad",
      op: "create",
      path: "Nova.md",
      hash_before: null,
      hash_after: "sha256:abc",
      session: "session-a",
      reason: "x",
      memory_id: null,
      commit_sha: null,
      created_at: "2026-07-01T00:00:00.000Z",
      status: null,
    } as unknown as TransactionRow;
    expect(() => j.recordTransaction(badRow)).toThrow(/NOT NULL/i);
  });

  test("DB enforces NOT NULL on required memory columns", () => {
    const j = makeJournal();
    const badRow = {
      id: "mem_bad",
      path: null,
      entity: "Nova",
      status: "active",
      confidence: null,
      created: "2026-07-01T00:00:00.000Z",
      source: null,
      supersedes: null,
      expires: null,
      last_referenced: null,
    } as unknown as MemoryRow;
    expect(() => j.insertMemory(badRow)).toThrow(/NOT NULL/i);
  });

  test("DB enforces NOT NULL on required approval columns", () => {
    const j = makeJournal();
    const badRow = {
      id: "appr_bad",
      held_operation: null,
      zone: "restricted",
      reason: "x",
      session: "session-a",
      state: "pending",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: null,
    } as unknown as ApprovalRow;
    expect(() => j.insertApproval(badRow)).toThrow(/NOT NULL/i);
  });
});

describe("Journal transactions", () => {
  function row(overrides: Partial<TransactionRow> = {}): TransactionRow {
    return {
      id: "tx_1",
      op: "create",
      path: "Nova.md",
      hash_before: null,
      hash_after: "sha256:abc",
      session: "session-a",
      reason: "initial capture",
      memory_id: "mem_1",
      commit_sha: "deadbeef",
      created_at: "2026-07-01T00:00:00.000Z",
      status: "applied",
      ...overrides,
    };
  }

  test("recordTransaction + getTransaction round-trips all fields", () => {
    const j = makeJournal();
    j.recordTransaction(row());
    const got = j.getTransaction("tx_1");
    expect(got).toEqual(row());
  });

  test("getTransaction returns null for unknown id", () => {
    const j = makeJournal();
    expect(j.getTransaction("nope")).toBeNull();
  });

  test("setTransactionStatus updates status", () => {
    const j = makeJournal();
    j.recordTransaction(row());
    j.setTransactionStatus("tx_1", "reverted");
    expect(j.getTransaction("tx_1")?.status).toBe("reverted");
  });

  test("setTransactionMemoryId links a transaction to a memory id", () => {
    const j = makeJournal();
    j.recordTransaction(row({ id: "tx_1", memory_id: null }));
    j.setTransactionMemoryId("tx_1", "mem_42");
    expect(j.getTransaction("tx_1")?.memory_id).toBe("mem_42");
  });

  test("listTransactions returns newest-first and respects limit", () => {
    const j = makeJournal();
    j.recordTransaction(row({ id: "tx_1", created_at: "2026-07-01T00:00:00.000Z" }));
    j.recordTransaction(row({ id: "tx_2", created_at: "2026-07-02T00:00:00.000Z" }));
    j.recordTransaction(row({ id: "tx_3", created_at: "2026-07-03T00:00:00.000Z" }));

    const all = j.listTransactions({});
    expect(all.map((t) => t.id)).toEqual(["tx_3", "tx_2", "tx_1"]);

    const limited = j.listTransactions({ limit: 2 });
    expect(limited.map((t) => t.id)).toEqual(["tx_3", "tx_2"]);
  });

  test("listTransactions breaks created_at ties by insertion order (newest rowid first)", () => {
    const j = makeJournal();
    const sameTs = "2026-07-01T00:00:00.000Z";
    // Insert three rows with the IDENTICAL created_at; newest-inserted must
    // come first so undoSession's newest-first guarantee holds.
    j.recordTransaction(row({ id: "tx_a", created_at: sameTs }));
    j.recordTransaction(row({ id: "tx_b", created_at: sameTs }));
    j.recordTransaction(row({ id: "tx_c", created_at: sameTs }));

    const all = j.listTransactions({});
    expect(all.map((t) => t.id)).toEqual(["tx_c", "tx_b", "tx_a"]);
  });

  test("listTransactions filters by session", () => {
    const j = makeJournal();
    j.recordTransaction(row({ id: "tx_1", session: "session-a" }));
    j.recordTransaction(row({ id: "tx_2", session: "session-b" }));

    const filtered = j.listTransactions({ session: "session-b" });
    expect(filtered.map((t) => t.id)).toEqual(["tx_2"]);
  });

  test("listTransactions filters by entity via memory_id join", () => {
    const j = makeJournal();
    j.insertMemory({
      id: "mem_1",
      path: "Nova.md",
      entity: "Nova",
      status: "active",
      confidence: "high",
      created: "2026-07-01T00:00:00.000Z",
      source: "chat",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });
    j.insertMemory({
      id: "mem_2",
      path: "Orion.md",
      entity: "Orion",
      status: "active",
      confidence: "high",
      created: "2026-07-01T00:00:00.000Z",
      source: "chat",
      supersedes: null,
      expires: null,
      last_referenced: null,
    });
    j.recordTransaction(row({ id: "tx_1", memory_id: "mem_1" }));
    j.recordTransaction(row({ id: "tx_2", memory_id: "mem_2" }));

    const filtered = j.listTransactions({ entity: "Nova" });
    expect(filtered.map((t) => t.id)).toEqual(["tx_1"]);
  });

  test("hasCommit returns true only for a recorded commit sha", () => {
    const j = makeJournal();
    j.recordTransaction(row({ id: "tx_1", commit_sha: "deadbeef" }));
    expect(j.hasCommit("deadbeef")).toBe(true);
    expect(j.hasCommit("nonexistent")).toBe(false);
  });
});

describe("Journal memories + tags", () => {
  function memRow(overrides: Partial<MemoryRow> = {}): MemoryRow {
    return {
      id: "mem_1",
      path: "Nova.md",
      entity: "Nova",
      status: "active",
      confidence: "high",
      created: "2026-07-01T00:00:00.000Z",
      source: "chat",
      supersedes: null,
      expires: null,
      last_referenced: null,
      ...overrides,
    };
  }

  test("insertMemory + addTags + getTags", () => {
    const j = makeJournal();
    j.insertMemory(memRow());
    j.addTags("mem_1", ["pref", "work"]);
    expect(j.getTags("mem_1").sort()).toEqual(["pref", "work"]);
  });

  test("queryMemories filters by entity", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", entity: "Nova" }));
    j.insertMemory(memRow({ id: "mem_2", entity: "Orion" }));
    const results = j.queryMemories({ entity: "Nova" });
    expect(results.map((m) => m.id)).toEqual(["mem_1"]);
  });

  test("queryMemories filters by tag", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1" }));
    j.insertMemory(memRow({ id: "mem_2" }));
    j.addTags("mem_1", ["pref"]);
    j.addTags("mem_2", ["work"]);
    const results = j.queryMemories({ tag: "pref" });
    expect(results.map((m) => m.id)).toEqual(["mem_1"]);
  });

  test("queryMemories filters by status", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", status: "active" }));
    j.insertMemory(memRow({ id: "mem_2", status: "archived" }));
    const results = j.queryMemories({ status: "archived" });
    expect(results.map((m) => m.id)).toEqual(["mem_2"]);
  });

  test("queryMemories filters by since (created >= iso), newest first, with limit", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", created: "2026-01-01T00:00:00.000Z" }));
    j.insertMemory(memRow({ id: "mem_2", created: "2026-06-01T00:00:00.000Z" }));
    j.insertMemory(memRow({ id: "mem_3", created: "2026-07-01T00:00:00.000Z" }));

    const results = j.queryMemories({ since: "2026-05-01T00:00:00.000Z" });
    expect(results.map((m) => m.id)).toEqual(["mem_3", "mem_2"]);

    const limited = j.queryMemories({ since: "2026-05-01T00:00:00.000Z", limit: 1 });
    expect(limited.map((m) => m.id)).toEqual(["mem_3"]);
  });

  test("setMemoryStatus is reflected in subsequent queryMemories", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", status: "active" }));
    j.setMemoryStatus("mem_1", "archived");
    expect(j.queryMemories({ status: "archived" }).map((m) => m.id)).toEqual(["mem_1"]);
    expect(j.queryMemories({ status: "active" }).map((m) => m.id)).toEqual([]);
  });

  test("updateMemory patches fields", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", confidence: "low" }));
    j.updateMemory("mem_1", { confidence: "high", expires: "2026-12-31T00:00:00.000Z" });
    const got = j.getMemory("mem_1");
    expect(got?.confidence).toBe("high");
    expect(got?.expires).toBe("2026-12-31T00:00:00.000Z");
  });

  test("touchMemory sets last_referenced", () => {
    const j = makeJournal();
    j.insertMemory(memRow({ id: "mem_1", last_referenced: null }));
    j.touchMemory("mem_1", "2026-07-02T12:00:00.000Z");
    expect(j.getMemory("mem_1")?.last_referenced).toBe("2026-07-02T12:00:00.000Z");
  });
});

describe("Journal approvals", () => {
  function approvalRow(overrides: Partial<ApprovalRow> = {}): ApprovalRow {
    return {
      id: "appr_1",
      held_operation: '{"op":"revise"}',
      zone: "restricted",
      reason: "needs human sign-off",
      session: "session-a",
      state: "pending",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: null,
      ...overrides,
    };
  }

  test("insertApproval + getApproval round-trips", () => {
    const j = makeJournal();
    j.insertApproval(approvalRow());
    expect(j.getApproval("appr_1")).toEqual(approvalRow());
  });

  test("listApprovals('pending') returns only pending, setApprovalState moves it out", () => {
    const j = makeJournal();
    j.insertApproval(approvalRow({ id: "appr_1", state: "pending" }));
    j.insertApproval(approvalRow({ id: "appr_2", state: "approved" }));

    const pending = j.listApprovals("pending");
    expect(pending.map((a) => a.id)).toEqual(["appr_1"]);

    j.setApprovalState("appr_1", "approved", "2026-07-02T00:00:00.000Z");
    expect(j.listApprovals("pending")).toEqual([]);
    const got = j.getApproval("appr_1");
    expect(got?.state).toBe("approved");
    expect(got?.resolved_at).toBe("2026-07-02T00:00:00.000Z");
  });
});

describe("Journal.runInTransaction", () => {
  test("commits all writes performed inside the callback", () => {
    const j = makeJournal();
    j.insertApproval({
      id: "appr_tx",
      held_operation: "{}",
      zone: "trusted",
      reason: null,
      session: "session-a",
      state: "pending",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: null,
    });

    j.runInTransaction(() => {
      j.setApprovalState("appr_tx", "approved", "2026-07-02T00:00:00.000Z");
    });

    expect(j.getApproval("appr_tx")?.state).toBe("approved");
  });

  test("rolls back all writes performed inside the callback if it throws", () => {
    const j = makeJournal();
    j.insertApproval({
      id: "appr_tx2",
      held_operation: "{}",
      zone: "trusted",
      reason: null,
      session: "session-a",
      state: "pending",
      created_at: "2026-07-01T00:00:00.000Z",
      resolved_at: null,
    });

    expect(() =>
      j.runInTransaction(() => {
        j.setApprovalState("appr_tx2", "approved", "2026-07-02T00:00:00.000Z");
        throw new Error("boom");
      }),
    ).toThrow("boom");

    // The state change must NOT have been committed.
    expect(j.getApproval("appr_tx2")?.state).toBe("pending");
  });
});
