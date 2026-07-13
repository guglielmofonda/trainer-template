import { after, NextResponse, type NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { safeEqual } from "@/lib/auth";
import { getStore } from "@/lib/store/fileStore";
import { applyCalibration, HevyClient, importFromHevy } from "@/lib/integrations/hevy";

/**
 * Hevy webhook receiver.
 *
 * Hevy POSTs `{ "workoutId": "..." }` here when you save a new workout and
 * expects a 200 within 5 seconds. We acknowledge immediately and (optionally)
 * recalibrate the program from your refreshed history *after* responding, using
 * Next's `after()` so the heavy fetch never blocks the 200.
 *
 * Security & config (env):
 *   HEVY_WEBHOOK_SECRET     required — the endpoint is disabled until it's set.
 *                           Register the URL in Hevy as
 *                           https://<host>/api/hevy/webhook?token=<secret>
 *                           (or send it as the `x-webhook-secret` header).
 *   HEVY_API_KEY            required for recalibration (to fetch your history).
 *   HEVY_WEBHOOK_AUTO_APPLY "true" to auto-apply confident starting-weight
 *                           updates after each workout. OFF by default — the
 *                           webhook only acknowledges + logs unless you opt in,
 *                           and it never touches a *locked* program.
 *
 * Note: a localhost dev server can't receive Hevy's POSTs directly — expose it
 * with a tunnel (e.g. `ngrok http 3000`) or deploy, then register that URL.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const secret = process.env.HEVY_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "Webhook not configured (set HEVY_WEBHOOK_SECRET)." }, { status: 503 });
  }
  const token = req.nextUrl.searchParams.get("token") ?? req.headers.get("x-webhook-secret");
  if (!token || !safeEqual(token, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let workoutId: string | undefined;
  try {
    workoutId = (await req.json())?.workoutId;
  } catch {
    /* fall through to the 400 below */
  }
  if (!workoutId || typeof workoutId !== "string") {
    return NextResponse.json({ error: "Missing workoutId" }, { status: 400 });
  }

  const apiKey = process.env.HEVY_API_KEY;
  const autoApply = process.env.HEVY_WEBHOOK_AUTO_APPLY === "true";

  if (apiKey && autoApply) {
    // Recalibrate AFTER responding so we stay well within Hevy's 5s budget.
    after(async () => {
      try {
        const store = getStore();
        const program = await store.getProgram();
        if (program.locked) return; // never mutate a frozen program
        const client = new HevyClient({ apiKey });
        const { report } = await importFromHevy(client, program);
        const result = await store.updateProgram((current) =>
          current.locked ? current : applyCalibration(current, report).program,
        );
        const changed = report.exercises.filter((e) => e.confidence === "high" || e.confidence === "medium").length;
        console.log(`[hevy webhook] workout ${workoutId} → recalibrated ${result.name} (${changed} confident lifts).`);
        for (const p of ["/configuration", "/program", "/session", "/coach"]) revalidatePath(p);
      } catch (err) {
        console.error("[hevy webhook] recalibration failed:", err instanceof Error ? err.message : err);
      }
    });
  } else {
    console.log(`[hevy webhook] received workout ${workoutId}` + (autoApply ? " (no HEVY_API_KEY — skipped recalibration)" : " (auto-apply off)."));
  }

  return NextResponse.json({ ok: true, received: workoutId, recalibrating: Boolean(apiKey && autoApply) });
}

/** Lightweight health check so you can verify the route is reachable. */
export function GET(): NextResponse {
  const configured = Boolean(process.env.HEVY_WEBHOOK_SECRET);
  return NextResponse.json({ ok: true, configured, autoApply: process.env.HEVY_WEBHOOK_AUTO_APPLY === "true" });
}
