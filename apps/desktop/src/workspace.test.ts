/// <reference types="bun-types" />
// The Workspace the dev server and the tests run on is the design fixture's,
// spelled out so the app bundle never loads the fixtures; this pins the copy.

import { expect, test } from "bun:test";
import { account, workspace } from "@monday/ui/fixtures";
import { FIXTURE_WORKSPACE } from "./workspace.tsx";

test("FIXTURE_WORKSPACE is the design fixture's Workspace", () => {
  expect(FIXTURE_WORKSPACE).toEqual({
    id: workspace.id,
    accountId: account.id,
    address: account.address,
  });
});
