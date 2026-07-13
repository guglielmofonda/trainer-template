import { PageHeader } from "@/components/ui";
import { CoachChat } from "@/components/CoachChat";
import { hasCoachKey } from "@/lib/coach/coach";

export const dynamic = "force-dynamic";

export default function CoachPage() {
  return (
    <div className="flex h-full flex-col">
      <PageHeader
        title="Training coach"
        sub="Grounded in your real program, logs, and Hevy history — it can adjust the plan and push routines to Hevy."
      />
      <CoachChat hasKey={hasCoachKey()} />
    </div>
  );
}
