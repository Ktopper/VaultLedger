import { describe, expect, test } from "vitest";
import { BrokerError, RejectionCode } from "../src/errors.js";

describe("BrokerError", () => {
  test("carries code, message, and retriable flag", () => {
    const err = new BrokerError("STALE_HASH", "hash mismatch");
    expect(err.code).toBe("STALE_HASH");
    expect(err.message).toBe("hash mismatch");
    expect(err.retriable).toBe(true);
  });

  test("toRejection returns {code, message, retriable}", () => {
    const err = new BrokerError("FORBIDDEN_ZONE", "cannot write to excluded zone");
    expect(err.toRejection()).toEqual({
      code: "FORBIDDEN_ZONE",
      message: "cannot write to excluded zone",
      retriable: false,
    });
  });

  test("STALE_HASH defaults to retriable", () => {
    const err = new BrokerError("STALE_HASH", "stale");
    expect(err.retriable).toBe(true);
  });

  test("FORBIDDEN_ZONE defaults to non-retriable", () => {
    const err = new BrokerError("FORBIDDEN_ZONE", "forbidden");
    expect(err.retriable).toBe(false);
  });

  test("REVERT_CONFLICT exists in the rejection code set", () => {
    expect(RejectionCode.REVERT_CONFLICT).toBe("REVERT_CONFLICT");
    const err = new BrokerError("REVERT_CONFLICT", "conflict");
    expect(err.retriable).toBe(false);
  });

  test("ALREADY_REVERTED exists in the rejection code set and defaults to non-retriable", () => {
    expect(RejectionCode.ALREADY_REVERTED).toBe("ALREADY_REVERTED");
    const err = new BrokerError("ALREADY_REVERTED", "already reverted");
    expect(err.retriable).toBe(false);
  });

  test("explicit retriable overrides the default", () => {
    const err = new BrokerError("FORBIDDEN_ZONE", "forbidden but flagged retriable", true);
    expect(err.retriable).toBe(true);
  });

  test("INVALID_TRANSITION exists in the rejection code set and defaults to non-retriable", () => {
    expect(RejectionCode.INVALID_TRANSITION).toBe("INVALID_TRANSITION");
    const err = new BrokerError("INVALID_TRANSITION", "unsupported status transition");
    expect(err.retriable).toBe(false);
  });

  test("INVALID_SOURCE exists in the rejection code set and defaults to non-retriable", () => {
    expect(RejectionCode.INVALID_SOURCE).toBe("INVALID_SOURCE");
    const err = new BrokerError("INVALID_SOURCE", "cited source not found");
    expect(err.retriable).toBe(false);
  });
});
