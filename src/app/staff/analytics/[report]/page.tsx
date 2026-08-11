import { notFound } from "next/navigation";
import { Suspense } from "react";
import { AnalyticsWorkspace } from "@/components/staff/AnalyticsWorkspace";
const reports = new Set(["revenue", "orders", "products", "customers", "production", "fulfillment", "support", "refunds", "inventory"]);
export default async function Page({ params }: { params: Promise<{ report: string }> }) { const { report } = await params; if (!reports.has(report)) notFound(); return <Suspense><AnalyticsWorkspace report={report as never} /></Suspense>; }
