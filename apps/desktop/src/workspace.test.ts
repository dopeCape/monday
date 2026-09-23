/// <reference types="bun-types" />
// The Workspace the dev server and the tests run on is the design fixture's,
// spelled out so the app bundle never loads the fixtures; this pins the copy.
// The switcher's seam: workspace.current names the Account whose Workspace
// opens, and a stale or empty value falls back to the first.

import { expect, test } from "bun:test";
import { account, NOW, workspace } from "@monday/ui/fixtures";
import { FIXTURE_WORKSPACE, pickAccount, workspaceOf } from "./workspace.tsx";

test("FIXTURE_WORKSPACE is the design fixture's Workspace", () => {
  expect(FIXTURE_WORKSPACE).toEqual({
    id: workspace.id,
    accountId: account.id,
    address: account.address,
    now: NOW,
  });
});

test("pickAccount opens the Account workspace.current names, else the first, else none", () => {
  const a = { id: "acct-a", workspaceId: "ws-a", address: "a@one.test" };
  const b = { id: "acct-b", workspaceId: "ws-b", address: "b@two.test" };
  expect(pickAccount([a, b], "acct-b")).toBe(b);
  expect(pickAccount([a, b], "")).toBe(a);
  expect(pickAccount([a, b], "acct-removed")).toBe(a);
  expect(pickAccount([], "acct-a")).toBeNull();
  expect(pickAccount(null, "acct-a")).toBeNull();
  expect(workspaceOf(b)).toEqual({ id: "ws-b", accountId: "acct-b", address: "b@two.test" });
});
