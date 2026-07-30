// src/app/banned/page.tsx
import { Suspense } from "react";
import BannedClient from "./BannedClient";

export default function BannedPage() {
  return (
    <Suspense fallback={<BannedFallback />}>
      <BannedClient />
    </Suspense>
  );
}

function BannedFallback() {
  return (
    <div className="mx-auto max-w-lg px-4 py-16 text-brand-text">
      <h1 className="mb-3 text-2xl font-semibold tracking-tight">
        Access blocked
      </h1>

      <p className="text-sm text-brand-textMuted">
        Your access has been blocked from this site.
      </p>

      <p className="mt-3 text-sm text-brand-textMuted">
        If you believe this is a mistake, contact the site owner or an admin and
        include your IP so they can review the ban.
      </p>
    </div>
  );
}
