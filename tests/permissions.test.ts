import assert from "node:assert/strict";
import test from "node:test";

import { permissionsForRole } from "../src/lib/permissions.ts";

test("support cannot restore recycle-bin content by default", () => {
  assert.equal(permissionsForRole("support").has("recycle_bin.restore"), false);
});

test("support cannot inherit moderator permissions through unknown role normalization", () => {
  assert.equal(permissionsForRole("support").has("community.restore_post"), false);
  assert.equal(permissionsForRole("unknown-role").has("recycle_bin.restore"), false);
});

test("administrators retain recycle-bin recovery capability", () => {
  assert.equal(permissionsForRole("admin").has("recycle_bin.restore"), true);
});
