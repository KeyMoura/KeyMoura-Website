import { WorkshopProjectForm } from "../WorkshopProjectForm";
export default function Page() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 text-brand-text">
      <p className="text-xs uppercase tracking-[.2em] text-brand-primary">
        Workshop
      </p>
      <h1 className="mt-2 text-3xl font-semibold">Post something you made</h1>
      <p className="mt-2 text-brand-textMuted">
        Share a CNC project, printed part, woodworking build, electronics
        project, or anything else you created.
      </p>
      <WorkshopProjectForm />
    </main>
  );
}
