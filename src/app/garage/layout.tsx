import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Garage",
  description: "Vehicle and build profiles shared by the KeyMoura community.",
  alternates: { canonical: "/garage" },
};

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
