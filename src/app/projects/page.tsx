import { Suspense } from "react";
import type { Metadata } from "next";
import ProjectsIndexClient from "./ProjectsIndexClient";

export const metadata: Metadata = {
  title: "Projects",
  description: "Build write-ups, reference pages, and finished work from the KeyMoura community.",
  alternates: { canonical: "/projects" },
};

export default function ProjectsPage() {
  return (
    <Suspense fallback={<div className="page-container text-brand-textMuted">Loading projects…</div>}>
      <ProjectsIndexClient />
    </Suspense>
  );
}
