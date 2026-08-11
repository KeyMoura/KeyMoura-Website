import assert from "node:assert/strict";
import test from "node:test";
import { PERMISSIONS } from "../src/lib/permissions.ts";
import { canManagePermissionSet, canManageRole } from "../src/lib/staff/userAccess.ts";

const actor = (overrides: Partial<Parameters<typeof canManagePermissionSet>[0]["actor"]> = {}) => ({
  userId: "limited-staff", roleKey: "support", roleRank: 40, isOp: false,
  permissions: new Set<string>(["permissions.grant", "support.view"]), ...overrides,
});

test("limited staff cannot grant a permission they do not possess", () => {
  const result = canManagePermissionSet({ actor: actor(), target: { userId: "customer-b", roleKey: "member", roleRank: 10 }, requestedPermissions: ["security.settings.manage"], knownPermissions: new Set(PERMISSIONS) });
  assert.equal(result.allowed, false);
});

test("arbitrary and nonexistent permission keys fail closed", () => {
  const result = canManagePermissionSet({ actor: actor(), target: { userId: "customer-b", roleKey: "member", roleRank: 10 }, requestedPermissions: ["root.everything"], knownPermissions: new Set(PERMISSIONS) });
  assert.deepEqual(result, { allowed: false, reason: "Unknown permission: root.everything", status: 400 });
});

test("staff cannot edit their own override or an equal/higher target", () => {
  for (const target of [{ userId: "limited-staff", roleKey: "support", roleRank: 40 }, { userId: "admin", roleKey: "admin", roleRank: 100 }]) {
    assert.equal(canManagePermissionSet({ actor: actor(), target, requestedPermissions: ["support.view"], knownPermissions: new Set(PERMISSIONS) }).allowed, false);
  }
});

test("role creation and editing cannot reach the actor rank", () => {
  assert.equal(canManageRole({ actor: actor(), nextRank: 40 }).allowed, false);
  assert.equal(canManageRole({ actor: actor(), targetRoleKey: "admin", targetRank: 100, nextRank: 20 }).allowed, false);
  assert.equal(canManageRole({ actor: actor(), targetRoleKey: "support", targetRank: 40, nextRank: 20 }).allowed, false);
});

test("owner remains the explicit hierarchy exception", () => {
  const owner = actor({ userId: "owner", roleKey: "admin", roleRank: Number.MAX_SAFE_INTEGER, isOp: true, permissions: new Set(PERMISSIONS) });
  assert.equal(canManagePermissionSet({ actor: owner, target: { userId: "admin", roleKey: "admin", roleRank: 100 }, requestedPermissions: ["security.settings.manage"], knownPermissions: new Set(PERMISSIONS) }).allowed, true);
});
