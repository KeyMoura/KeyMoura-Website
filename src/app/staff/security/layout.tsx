import { ReactNode } from "react";

/**
 * Staff → Security layout.
 *
 * The staff shell already provides primary navigation on the left.
 * This layout intentionally keeps Security pages free of an extra sub-nav
 * so the UI does not feel "double navigated".
 */
export default function StaffSecurityLayout({ children }: { children: ReactNode }) {
  return children;
}
