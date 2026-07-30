"use client";

import React from "react";
import { useQuery } from "@tanstack/react-query";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import {
  faBook,
  faChessRook,
  faGavel,
  faShieldHeart,
  faShieldCat,
  faShieldDog,
} from "@fortawesome/free-solid-svg-icons";
import { getRoleMeta, normalizeRole } from "@/lib/roles";
import { isArray, isRecord, isString } from "@/lib/typeGuards";

const cn = (...classes: Array<string | false | null | undefined>) =>
  classes.filter(Boolean).join(" ");

type Props = {
  role: unknown;
  className?: string;
  /** Override pill text size (defaults to 10px to match existing UI) */
  sizeClassName?: string;
};

type DbRoleStyle = {
  key: string;
  label: string;
  badge_bg: string;
  badge_border: string;
  badge_text: string;
  badge_icon: string | null;
};

const DEFAULT_BADGE_BG = "#111827";
const DEFAULT_BADGE_BORDER = "#374151";
const DEFAULT_BADGE_TEXT = "#E5E7EB";

type RolesPayload = {
  roles: DbRoleStyle[];
};

function normalizeRolesPayload(v: unknown): RolesPayload {
  if (!isRecord(v) || !isArray(v.roles)) return { roles: [] };
  const roles: DbRoleStyle[] = [];
  for (const r of v.roles) {
    if (!isRecord(r)) continue;
    if (!isString(r.key) || !isString(r.label)) continue;
    const badge_bg = isString(r.badge_bg) ? r.badge_bg : DEFAULT_BADGE_BG;
    const badge_border = isString(r.badge_border) ? r.badge_border : DEFAULT_BADGE_BORDER;
    const badge_text = isString(r.badge_text) ? r.badge_text : DEFAULT_BADGE_TEXT;
    const badge_icon = isString(r.badge_icon) ? r.badge_icon : null;
    roles.push({
      key: r.key,
      label: r.label,
      badge_bg,
      badge_border,
      badge_text,
      badge_icon,
    });
  }
  return { roles };
}

function iconForName(
  name: "shield-heart" | "shield-cat" | "shield-dog" | "gavel" | "chess-rook" | "book" | null
) {
  if (name === "shield-heart") return faShieldHeart;
  if (name === "shield-cat") return faShieldCat;
  if (name === "shield-dog") return faShieldDog;
  if (name === "gavel") return faGavel;
  if (name === "chess-rook") return faChessRook;
  if (name === "book") return faBook;
  return null;
}

function asKnownIconName(v: unknown):
  | "shield-heart"
  | "shield-cat"
  | "shield-dog"
  | "gavel"
  | "chess-rook"
  | "book"
  | null {
  if (!isString(v)) return null;
  const s = v.toLowerCase();
  if (s === "shield-heart") return "shield-heart";
  if (s === "shield-cat") return "shield-cat";
  if (s === "shield-dog") return "shield-dog";
  if (s === "gavel") return "gavel";
  if (s === "chess-rook") return "chess-rook";
  if (s === "book") return "book";
  return null;
}

export function RolePill({ role, className, sizeClassName }: Props) {
  const key = normalizeRole(role);
  const meta = getRoleMeta(key);
  const { data } = useQuery({
    queryKey: ["roleStyles"],
    queryFn: async (): Promise<RolesPayload> => {
      const res = await fetch("/api/public/roles", { method: "GET" });
      if (!res.ok) return { roles: [] };
      const json = (await res.json().catch(() => null)) as unknown;
      return normalizeRolesPayload(json);
    },
    staleTime: 10 * 60 * 1000,
    gcTime: 30 * 60 * 1000,
  });

  const rawDb = data?.roles.find((r) => r.key === key) ?? null;

  /**
   * Treat database styles as optional overrides.
   *
   * If the database row looks like an unconfigured default (all default colors + no icon override),
   * fall back to the code registry so roles always render with the expected brand colors + icons.
   */
  const db =
    rawDb &&
    (rawDb.badge_bg !== DEFAULT_BADGE_BG ||
      rawDb.badge_border !== DEFAULT_BADGE_BORDER ||
      rawDb.badge_text !== DEFAULT_BADGE_TEXT ||
      rawDb.badge_icon !== null ||
      rawDb.label !== meta.label)
      ? rawDb
      : null;
  const icon = iconForName(asKnownIconName(db?.badge_icon ?? meta.icon));
  const label = db?.label ?? meta.label;
  const style = db
    ? ({
        backgroundColor: db.badge_bg,
        borderColor: db.badge_border,
        color: db.badge_text,
      } as const)
    : undefined;

  return (
    <span
      className={cn(
        /** Pill base layout. */
        "inline-flex min-h-[24px] shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 font-medium",
        sizeClassName ?? "text-[10px]",
        db ? "" : meta.pillClass,
        className
      )}
      style={style}
    >
      {icon ? (
        <FontAwesomeIcon
          icon={icon}
          className="h-3 w-3"
          style={{ color: "currentColor" }}
          aria-hidden
        />
      ) : null}
      <span className="leading-none">{label}</span>
    </span>
  );
}
