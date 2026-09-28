// What a failed MCP connect or call reads as: a 401 asks to sign in, a 402
// says the provider wants a paid plan (a paid proxy such as a hosted Slack
// server answers 402 before any sign-in), anything else is an error as is.

import { describe, expect, test } from "bun:test";
import { statusOfError } from "../src/workflows/mcp.ts";

describe("statusOfError", () => {
  test("402 Payment Required says the provider wants a paid plan", () => {
    const sdk = Object.assign(new Error("Error POSTing to endpoint (HTTP 402): Payment Required"), {
      code: 402,
    });
    for (const error of [sdk, new Error("wrapped", { cause: sdk })]) {
      const status = statusOfError(error);
      expect(status.status).toBe("error");
      expect(status.message).toContain("paid plan");
    }
  });

  test("401 still asks to sign in, and other errors keep their words", () => {
    expect(statusOfError(Object.assign(new Error("nope"), { code: 401 })).status).toBe(
      "needs_sign_in",
    );
    expect(statusOfError(new Error("connection reset"))).toEqual({
      status: "error",
      message: "connection reset",
    });
  });
});
