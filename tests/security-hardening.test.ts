import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  canManageRole,
  canSetRolePermissions,
  canSetUserPermissions,
  unknownPermissionKeys,
  wouldRemoveLastAdmin,
  type AccessActor,
  type AccessTarget,
} from "../src/lib/staff/userAccess.ts";

const actor = (overrides: Partial<AccessActor> = {}): AccessActor => ({
  userId: "moderator-id",
  roleKey: "moderator",
  roleRank: 60,
  isOp: false,
  permissions: new Set(["roles.manage", "permissions.grant", "orders.view"]),
  ...overrides,
});

const target = (overrides: Partial<AccessTarget> = {}): AccessTarget => ({
  userId: "member-id",
  roleKey: "member",
  roleRank: 10,
  ...overrides,
});

test("direct permission overrides deny self, equal, and stronger targets", () => {
  for (const candidate of [
    target({ userId: "moderator-id" }),
    target({ roleKey: "peer", roleRank: 60 }),
    target({ roleKey: "admin", roleRank: 100 }),
  ]) {
    assert.equal(canSetUserPermissions({ actor: actor(), target: candidate, permissions: [] }).allowed, false);
  }
});

test("permission mutations reject unknown keys and grants the actor lacks", () => {
  assert.deepEqual(unknownPermissionKeys(["orders.view", "invented.root", "invented.root"]), ["invented.root"]);
  assert.equal(
    canSetUserPermissions({ actor: actor(), target: target(), permissions: ["invented.root"] }).allowed,
    false
  );
  assert.equal(
    canSetUserPermissions({ actor: actor(), target: target(), permissions: ["refunds.issue"] }).allowed,
    false
  );
  assert.equal(
    canSetRolePermissions({ actor: actor(), targetRoleRank: 10, permissions: ["refunds.issue"] }).allowed,
    false
  );
});

test("role creation and editing stay strictly below the actor", () => {
  assert.equal(canManageRole({ actor: actor(), nextRoleRank: 60 }).allowed, false, "equal create");
  assert.equal(canManageRole({ actor: actor(), nextRoleRank: 100 }).allowed, false, "stronger create");
  assert.equal(
    canManageRole({ actor: actor(), targetRoleRank: 10, nextRoleRank: 60 }).allowed,
    false,
    "raise to actor"
  );
  assert.equal(
    canManageRole({ actor: actor(), targetRoleRank: 100, nextRoleRank: 10 }).allowed,
    false,
    "modify stronger role"
  );
  assert.equal(canSetRolePermissions({ actor: actor(), targetRoleRank: 60, permissions: [] }).allowed, false);
});

test("operator hierarchy exception is intentional but canonical keys remain mandatory", () => {
  const operator = actor({ isOp: true, roleRank: 0, permissions: new Set(["roles.manage", "permissions.grant"]) });
  assert.equal(canManageRole({ actor: operator, targetRoleRank: 100, nextRoleRank: 100 }).allowed, true);
  assert.equal(
    canSetUserPermissions({ actor: operator, target: target({ userId: operator.userId }), permissions: ["orders.view"] })
      .allowed,
    true
  );
  assert.equal(
    canSetUserPermissions({ actor: operator, target: target(), permissions: ["invented.root"] }).allowed,
    false
  );
});

test("last administrator protection remains independent of hierarchy exceptions", () => {
  assert.equal(wouldRemoveLastAdmin({ currentRoleKey: "admin", nextRoleKey: "member", adminCount: 1 }), true);
  assert.equal(wouldRemoveLastAdmin({ currentRoleKey: "admin", nextRoleKey: "member", adminCount: 2 }), false);
});

test("service-role mutation routes invoke shared guards before their writes", () => {
  const root = new URL("../", import.meta.url);
  const cases = [
    ["src/app/api/staff/security/roles/route.ts", "canManageRole", '.from("roles").insert'],
    ["src/app/api/staff/security/roles/[key]/route.ts", "canManageRole", '.from("roles")\n    .update'],
    [
      "src/app/api/staff/security/roles/[key]/permissions/route.ts",
      "canSetRolePermissions",
      '.from("role_permissions").delete',
    ],
    [
      "src/app/api/staff/security/users/[id]/permissions/route.ts",
      "canSetUserPermissions",
      '.from("user_permissions").delete',
    ],
  ] as const;

  for (const [path, guard, write] of cases) {
    const source = readFileSync(new URL(path, root), "utf8");
    assert.ok(source.indexOf(`${guard}({`) >= 0, `${path} must enforce ${guard}`);
    assert.ok(source.indexOf(`${guard}({`) < source.indexOf(write), `${path} must guard before its service-role write`);
  }
});
