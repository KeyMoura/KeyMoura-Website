import { notFound } from "next/navigation";

import MenuSelectDemo from "./ui";

export default function MenuSelectDevPage() {
  // Keep this route out of production.
  if (process.env.NODE_ENV === "production") notFound();

  return <MenuSelectDemo />;
}
