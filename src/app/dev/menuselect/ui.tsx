"use client";

import { useMemo, useState } from "react";
import { MenuSelect } from "@/components/ui/MenuSelect";

type Opt = { value: string; label: string; badge?: string };

function makeLongOptions(): Opt[] {
  const out: Opt[] = [];
  for (let i = 1; i <= 30; i++) {
    out.push({ value: `opt_${i}`, label: `Option ${i}`, badge: i % 3 === 0 ? "Admin" : undefined });
  }
  return out;
}

export default function MenuSelectDemo() {
  const roles: Opt[] = useMemo(
    () => [
      { value: "admin", label: "Admin", badge: "Admin" },
      { value: "moderator", label: "Moderator", badge: "Mod" },
      { value: "support", label: "Support", badge: "Support" },
      { value: "user", label: "User" },
    ],
    []
  );

  const longOptions = useMemo(() => makeLongOptions(), []);

  const [role, setRole] = useState("admin");
  const [longValue, setLongValue] = useState("opt_1");

  return (
    <div className="page-container page-stack">
      <h1 className="text-lg font-semibold">MenuSelect Dev Demo</h1>
      <p className="text-sm text-brand-textMuted">
        This route is dev-only and returns 404 in production.
      </p>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs text-brand-textMuted">Small list</div>
          <div className="mt-2">
            <MenuSelect
              ariaLabel="Role"
              value={role}
              onChange={setRole}
              options={roles.map((r) => ({
                value: r.value,
                label: r.badge ? `[${r.badge}] ${r.label}` : r.label,
              }))}
            />
          </div>
        </div>

        <div className="rounded-xl border border-white/10 bg-white/5 p-4">
          <div className="text-xs text-brand-textMuted">Long list (scroll)</div>
          <div className="mt-2">
            <MenuSelect
              ariaLabel="Long"
              value={longValue}
              onChange={setLongValue}
              options={longOptions.map((o) => ({
                value: o.value,
                label: o.badge ? `[${o.badge}] ${o.label}` : o.label,
              }))}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
