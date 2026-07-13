import { NextRequest } from "next/server";
import { revalidatePath } from "next/cache";
import { streamCoachTurn, type CoachEvent, type CoachTurn } from "@/lib/coach/coach";
import { MUTATING_TOOLS } from "@/lib/coach/tools";
import { getStore } from "@/lib/store/fileStore";
import type { CoachMessage } from "@/lib/store/types";

export const runtime = "nodejs";
// The coach can run several model + tool round-trips (Hevy pushes, plan edits).
export const maxDuration = 300;

interface Body {
  /** Existing durable conversation; omit to start a new one. */
  threadId?: string | null;
  message?: { id?: string; content?: string };
  /** Legacy shapes retained while older browser bundles age out. */
  messages?: Array<{ role?: string; content?: string }>;
  question?: string;
}

interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

function summarizeThread(thread: {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: CoachMessage[];
}): ThreadSummary {
  return {
    id: thread.id,
    title: thread.title,
    createdAt: thread.createdAt,
    updatedAt: thread.updatedAt,
    messageCount: thread.messages.length,
  };
}

export async function GET(req: NextRequest) {
  const store = getStore();
  const threads = (await store.getCoachThreads()).sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const requestedId = req.nextUrl.searchParams.get("threadId");
  const activeThread = requestedId
    ? threads.find((thread) => thread.id === requestedId) ?? null
    : threads[0] ?? null;

  return Response.json(
    {
      threads: threads.map(summarizeThread),
      activeThread,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

function parseMessage(body: Body): CoachMessage | null {
  const legacyTurns = parseLegacyTurns(body.messages);
  const content = (
    body.message?.content ??
    body.question ??
    (legacyTurns?.at(-1)?.role === "user" ? legacyTurns.at(-1)?.content : "") ??
    ""
  ).trim();
  if (!content || content.length > 20_000) return null;
  const suppliedId = body.message?.id?.trim();
  return {
    id: suppliedId && suppliedId.length <= 100 ? suppliedId : crypto.randomUUID(),
    role: "user",
    content,
    createdAt: new Date().toISOString(),
  };
}

function parseLegacyTurns(messages: Body["messages"]): CoachTurn[] | null {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const turns = messages.flatMap((message): CoachTurn[] => {
    const role = message.role === "user" || message.role === "assistant" ? message.role : null;
    const content = (message.content ?? "").trim();
    return role && content ? [{ role, content }] : [];
  });
  return turns.at(-1)?.role === "user" ? turns : null;
}

export async function POST(req: NextRequest) {
  let body: Body;
  try {
    body = await req.json();
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  const userMessage = parseMessage(body);
  if (!userMessage) return new Response("Missing or malformed message", { status: 400 });

  const store = getStore();
  let thread;
  try {
    thread = body.threadId
      ? await store.appendCoachMessage(body.threadId, userMessage)
      : await store.startCoachThread(userMessage);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Conversation unavailable.";
    return new Response(message, { status: message.includes("not found") ? 404 : 500 });
  }
  const turns: CoachTurn[] =
    parseLegacyTurns(body.messages) ??
    thread.messages.map((message) => ({
      role: message.role,
      content: message.content,
    }));
  const assistantMessageId = crypto.randomUUID();

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let mutated = false;
      let assistantText = "";
      const emit = (event: CoachEvent) =>
        controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      try {
        for await (const event of streamCoachTurn({ turns, signal: req.signal })) {
          if (event.type === "text") assistantText += event.text;
          if (event.type === "tool_end" && event.ok && MUTATING_TOOLS.has(event.name)) {
            mutated = true;
          }
          emit(event);
        }
        if (assistantText.trim()) {
          await store.appendCoachMessage(thread.id, {
            id: assistantMessageId,
            role: "assistant",
            content: assistantText.trim(),
            createdAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : "coach error";
        emit({ type: "error", message });
        emit({ type: "done" });
      } finally {
        if (mutated) {
          for (const path of ["/", "/program", "/session", "/coach", "/configuration", "/progress"]) {
            revalidatePath(path);
          }
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Coach-Thread-Id": thread.id,
    },
  });
}
