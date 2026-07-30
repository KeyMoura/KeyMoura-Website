// src/app/info/page.tsx
import { Suspense } from "react";
import InfoIndexClient from "./InfoIndexClient";

export default function InfoPage() {
  return (
    <Suspense fallback={<div className="mx-auto max-w-6xl px-4 py-8 text-brand-textMuted">Loading…</div>}>
      <InfoIndexClient />
    </Suspense>
  );
}
