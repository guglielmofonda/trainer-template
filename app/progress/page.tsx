import { loadHevyProgress } from "@/app/actions";
import { ProgressDashboard } from "@/components/ProgressDashboard";

export const dynamic = "force-dynamic";

export default async function ProgressPage() {
  // This route is dynamic, so opening it always pulls a fresh server-owned
  // snapshot. The athlete never has to manage integration credentials or a
  // separate refresh step.
  const initialResult = await loadHevyProgress({ windowDays: 365 });

  return <ProgressDashboard initialResult={initialResult} />;
}
