// src/app/banned/BannedClient.tsx
"use client";

import { useSearchParams } from "next/navigation";

export default function BannedClient() {
  const searchParams = useSearchParams();
  const ip = searchParams.get("ip");

  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-brand-text">
      <h1 className="mb-3 text-2xl font-semibold tracking-tight">
        Access blocked
      </h1>

      <p className="text-sm text-brand-textMuted">
        Your IP{ip ? ` (${ip})` : ""} has been blocked from accessing this site.
      </p>

      <p className="mt-3 text-sm text-brand-textMuted">
        If you believe this is a mistake, contact the site owner or an admin and
        include your IP so they can review the ban.
      </p>
    </div>
  );
}
