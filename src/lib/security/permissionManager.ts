import type { PermissionKey } from "@/lib/permissions";

export function getMaxNumericPermission(
  permissions: ReadonlySet<PermissionKey>,
  prefix: string
): number {
  let max = 0;
  for (const permission of permissions) {
    if (!permission.startsWith(prefix)) continue;
    const value = Number(permission.slice(prefix.length));
    if (Number.isFinite(value)) {
      max = Math.max(max, value);
    }
  }
  return max;
}
