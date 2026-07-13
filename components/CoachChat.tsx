"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUp,
  Check,
  History,
  Loader2,
  MessageSquarePlus,
  Sparkles,
  X,
} from "lucide-react";
import { BrandMark } from "@/components/ui";
import { coachThreadTitle } from "@/lib/store/types";

const SUGGESTIONS = [
  "I'm training tomorrow and the day after, back to back — restructure both days so they stack sensibly, then push them to Hevy.",
  "Review my current week and call out anything I should watch.",
  "Pull my recent Hevy workouts — am I progressing on the big lifts?",
  "Today's top single felt heavy — what should I adjust for the rest of the session?",
];

interface ToolChip {
  id: string;
  name: string;
  label: string;
  status: "running" | "ok" | "error";
  summary?: string;
}

type Segment =
  | { kind: "text"; text: string }
  | { kind: "tools"; items: ToolChip[] }
  | { kind: "notice"; message: string };

interface Turn {
  role: "user" | "coach";
  segments: Segment[];
}

interface PersistedMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

interface PersistedThread {
  id: string;
  title: string;
  messages: PersistedMessage[];
  createdAt: string;
  updatedAt: string;
}

interface ThreadSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

interface ConversationsResponse {
  threads: ThreadSummary[];
  activeThread: PersistedThread | null;
}

/** Flatten a turn's text segments for display and model history. */
function turnText(turn: Turn): string {
  return turn.segments
    .filter((segment): segment is { kind: "text"; text: string } => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n\n")
    .trim();
}

function toTurns(messages: PersistedMessage[]): Turn[] {
  return messages.map((message) => ({
    role: message.role === "assistant" ? "coach" : "user",
    segments: [{ kind: "text", text: message.content }],
  }));
}

export function CoachChat({ hasKey }: { hasKey: boolean }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const activeThread = threads.find((thread) => thread.id === activeThreadId) ?? null;

  useEffect(() => {
    void loadConversation();
  }, []);

  useEffect(() => {
    const refresh = () => {
      if (!streaming && activeThreadId && document.visibilityState === "visible") {
        void loadConversation(activeThreadId, false);
      }
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [activeThreadId, streaming]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [turns, streaming]);

  useEffect(() => {
    const element = inputRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(element.scrollHeight, 120)}px`;
  }, [input]);

  useEffect(() => {
    if (!historyOpen) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") setHistoryOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [historyOpen]);

  async function loadConversation(threadId?: string, showLoading = true) {
    if (showLoading) setLoading(true);
    setLoadError(false);
    try {
      const query = threadId ? `?threadId=${encodeURIComponent(threadId)}` : "";
      const response = await fetch(`/api/coach${query}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`conversation unavailable (${response.status})`);
      const data = (await response.json()) as ConversationsResponse;
      setThreads(data.threads);
      setActiveThreadId(data.activeThread?.id ?? null);
      setTurns(data.activeThread ? toTurns(data.activeThread.messages) : []);
    } catch {
      setLoadError(true);
    } finally {
      if (showLoading) setLoading(false);
    }
  }

  function startNewChat() {
    if (streaming) return;
    setActiveThreadId(null);
    setTurns([]);
    setInput("");
    setHistoryOpen(false);
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function selectThread(threadId: string) {
    if (streaming || threadId === activeThreadId) {
      setHistoryOpen(false);
      return;
    }
    setHistoryOpen(false);
    await loadConversation(threadId);
  }

  /** Mutate the streaming coach turn (always the last turn) immutably. */
  function patchCoachTurn(fn: (segments: Segment[]) => Segment[]) {
    setTurns((all) => {
      const copy = [...all];
      const last = copy[copy.length - 1];
      if (!last || last.role !== "coach") return all;
      copy[copy.length - 1] = { ...last, segments: fn(last.segments.map((segment) => ({ ...segment }))) };
      return copy;
    });
  }

  function applyEvent(event: Record<string, unknown>) {
    switch (event.type) {
      case "text": {
        const text = String(event.text ?? "");
        if (!text) return;
        patchCoachTurn((segments) => {
          const last = segments[segments.length - 1];
          if (last?.kind === "text") {
            segments[segments.length - 1] = { kind: "text", text: last.text + text };
            return segments;
          }
          return [...segments, { kind: "text", text }];
        });
        break;
      }
      case "tool_start": {
        const chip: ToolChip = {
          id: String(event.id),
          name: String(event.name ?? ""),
          label: String(event.label ?? event.name ?? "Working"),
          status: "running",
        };
        patchCoachTurn((segments) => {
          const last = segments[segments.length - 1];
          if (last?.kind === "tools") {
            segments[segments.length - 1] = { kind: "tools", items: [...last.items, chip] };
            return segments;
          }
          return [...segments, { kind: "tools", items: [chip] }];
        });
        break;
      }
      case "tool_end": {
        patchCoachTurn((segments) =>
          segments.map((segment) =>
            segment.kind === "tools"
              ? {
                  kind: "tools",
                  items: segment.items.map((chip) =>
                    chip.id === event.id
                      ? {
                          ...chip,
                          status: event.ok ? ("ok" as const) : ("error" as const),
                          summary: String(event.summary ?? ""),
                        }
                      : chip,
                  ),
                }
              : segment,
          ),
        );
        break;
      }
      case "error": {
        const message = String(event.message ?? "The coach hit an error.");
        patchCoachTurn((segments) => [...segments, { kind: "notice", message }]);
        break;
      }
    }
  }

  async function ask(question: string) {
    const content = question.trim();
    if (!content || streaming || loading) return;
    setInput("");

    const userTurn: Turn = { role: "user", segments: [{ kind: "text", text: content }] };
    setTurns((history) => [...history, userTurn, { role: "coach", segments: [] }]);
    setStreaming(true);

    let persistedThreadId = activeThreadId;
    let failed = false;
    try {
      const response = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          threadId: activeThreadId,
          message: { id: crypto.randomUUID(), content },
        }),
      });
      if (!response.ok || !response.body) throw new Error(`coach unavailable (${response.status})`);

      persistedThreadId = response.headers.get("X-Coach-Thread-Id") ?? activeThreadId;
      if (persistedThreadId) {
        const newThreadId = persistedThreadId;
        setActiveThreadId(newThreadId);
        const now = new Date().toISOString();
        setThreads((current) => {
          if (current.some((thread) => thread.id === newThreadId)) return current;
          return [
            {
              id: newThreadId,
              title: coachThreadTitle(content),
              createdAt: now,
              updatedAt: now,
              messageCount: 1,
            },
            ...current,
          ];
        });
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      const feed = (line: string) => {
        if (!line.trim()) return;
        try {
          const event = JSON.parse(line) as Record<string, unknown>;
          if (event.type === "error") failed = true;
          applyEvent(event);
        } catch {
          // A partial NDJSON line remains buffered until the next network chunk.
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        lines.forEach(feed);
      }
      feed(buffer);
    } catch {
      failed = true;
      patchCoachTurn((segments) => [
        ...segments,
        {
          kind: "notice",
          message: "The coach hit a connection error. Reopen this chat before retrying; your message may already be saved.",
        },
      ]);
    } finally {
      setStreaming(false);
      if (!failed && persistedThreadId) await loadConversation(persistedThreadId, false);
    }
  }

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(input);
    }
  }

  const empty = turns.length === 0;

  return (
    <div className="relative flex min-h-0 flex-1 overflow-hidden">
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border-soft bg-surface lg:flex">
        <ConversationList
          threads={threads}
          activeThreadId={activeThreadId}
          disabled={streaming}
          onSelect={(id) => void selectThread(id)}
        />
      </aside>

      {historyOpen && (
        <div className="absolute inset-0 z-[300] flex lg:hidden" role="dialog" aria-modal="true" aria-label="Saved conversations">
          <button
            type="button"
            className="absolute inset-0 bg-ink/20"
            onClick={() => setHistoryOpen(false)}
            aria-label="Close conversation history"
          />
          <aside className="relative z-[301] flex w-[min(86vw,20rem)] flex-col border-r border-border bg-surface">
            <ConversationList
              threads={threads}
              activeThreadId={activeThreadId}
              disabled={streaming}
              onSelect={(id) => void selectThread(id)}
              onClose={() => setHistoryOpen(false)}
            />
          </aside>
        </div>
      )}

      <section className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-h-11 items-center gap-2 border-b border-border-soft bg-bg px-3 sm:px-4">
          <button
            type="button"
            onClick={() => setHistoryOpen(true)}
            className="inline-flex h-8 items-center gap-1.5 rounded-[2px] border border-border px-2.5 text-[0.75rem] text-muted hover:border-border-strong hover:bg-surface lg:hidden"
            aria-expanded={historyOpen}
          >
            <History className="size-3.5" />
            History
          </button>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[0.75rem] font-medium text-ink">
              {activeThread?.title ?? "New conversation"}
            </p>
            <p className="hidden text-[0.625rem] text-faint sm:block">Saved across your signed-in devices</p>
          </div>
          <button
            type="button"
            onClick={startNewChat}
            disabled={streaming || (empty && !activeThreadId)}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[2px] border border-border bg-bg px-2.5 text-[0.75rem] text-muted transition-colors hover:border-border-strong hover:bg-surface hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
          >
            <MessageSquarePlus className="size-3.5" />
            <span className="hidden sm:inline">New chat</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>

        <div
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 py-4 sm:px-6 sm:py-6 ${
            empty && !loading && !loadError ? "flex flex-col items-center justify-center" : ""
          }`}
        >
          {loading ? (
            <div className="grid h-full place-items-center text-faint" aria-label="Loading saved conversation">
              <Loader2 className="size-5 animate-spin" />
            </div>
          ) : loadError ? (
            <div className="mx-auto grid h-full max-w-sm place-items-center text-center">
              <div>
                <AlertTriangle className="mx-auto size-5 text-danger" />
                <p className="mt-2 text-sm font-medium text-ink">Conversation history is unavailable</p>
                <p className="mt-1 text-xs leading-relaxed text-muted">Your saved chats were not changed. Check the connection and try again.</p>
                <button
                  type="button"
                  onClick={() => void loadConversation(activeThreadId ?? undefined)}
                  className="mt-3 h-8 rounded-[2px] border border-border bg-bg px-3 text-xs text-ink hover:bg-surface"
                >
                  Try again
                </button>
              </div>
            </div>
          ) : empty ? (
            <div className="mx-auto max-w-lg text-center">
              <div className="mx-auto grid size-11 place-items-center rounded-[2px] bg-surface-2 text-ink-strong ring-1 ring-inset ring-border">
                <Sparkles className="size-5" />
              </div>
              <h2 className="mt-4 text-lg font-semibold tracking-tight">Chat with your training data</h2>
              <p className="mx-auto mt-2 max-w-md text-[0.8125rem] leading-relaxed text-muted">
                The coach reads your program, prescriptions, volume, and real Hevy history — and on your say-so it restructures training days and pushes the updated routines straight to Hevy.
              </p>
              <p className="mt-2 text-[0.6875rem] text-faint">Conversations are saved privately so you can continue on another device.</p>
              {!hasKey && (
                <p className="mt-3 inline-flex items-center gap-1.5 rounded-[2px] border border-border-soft bg-surface-2 px-3 py-1 text-[0.6875rem] text-muted">
                  <span className="size-1.5 rounded-full bg-muted" />
                  Offline mode — set ANTHROPIC_API_KEY for the conversational coach with tools
                </p>
              )}
              <div className="mt-5 grid gap-2 text-left sm:mt-6 sm:grid-cols-2">
                {SUGGESTIONS.map((suggestion) => (
                  <button
                    key={suggestion}
                    onClick={() => void ask(suggestion)}
                    className="rounded-[3px] border border-border-soft bg-surface px-3.5 py-2.5 text-[0.75rem] leading-relaxed text-muted transition-colors hover:border-border hover:bg-surface-2 hover:text-ink sm:py-3 sm:text-[0.8125rem]"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-2xl space-y-5">
              {turns.map((turn, index) =>
                turn.role === "user" ? (
                  <div key={index} className="flex justify-end">
                    <div className="max-w-[92%] whitespace-pre-wrap rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2.5 text-[0.8125rem] sm:max-w-[85%] sm:px-4">
                      {turnText(turn)}
                    </div>
                  </div>
                ) : (
                  <div key={index} className="flex gap-2.5 sm:gap-3">
                    <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-[2px] bg-surface-2 text-ink-strong ring-1 ring-inset ring-border">
                      <BrandMark className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1 space-y-2 pt-0.5 text-[0.875rem] leading-relaxed">
                      {turn.segments.length === 0 && streaming && index === turns.length - 1 ? (
                        <ThinkingDots />
                      ) : (
                        turn.segments.map((segment, segmentIndex) => <SegmentView key={segmentIndex} segment={segment} />)
                      )}
                    </div>
                  </div>
                ),
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border bg-bg px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3 sm:p-4">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void ask(input);
            }}
            className="mx-auto flex max-w-2xl items-end gap-2"
          >
            <textarea
              ref={inputRef}
              rows={1}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder="Ask your training coach…"
              aria-label="Message the training coach"
              disabled={loading || loadError}
              className="max-h-[120px] min-h-11 flex-1 resize-none rounded-[3px] border border-border-soft bg-surface px-3.5 py-2.5 text-[16px] leading-[1.4] outline-none transition-colors placeholder:text-faint focus:border-accent disabled:opacity-50 sm:text-sm"
            />
            <button
              type="submit"
              disabled={streaming || loading || loadError || !input.trim()}
              aria-label="Send message"
              className="grid size-11 shrink-0 place-items-center rounded-[2px] bg-ink-strong text-bg transition-colors hover:bg-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ArrowUp className="size-4.5" strokeWidth={2.5} />
            </button>
          </form>
        </div>
      </section>
    </div>
  );
}

function ConversationList({
  threads,
  activeThreadId,
  disabled,
  onSelect,
  onClose,
}: {
  threads: ThreadSummary[];
  activeThreadId: string | null;
  disabled: boolean;
  onSelect: (id: string) => void;
  onClose?: () => void;
}) {
  return (
    <>
      <div className="flex min-h-11 items-center justify-between border-b border-border-soft px-3.5">
        <p className="label text-faint">Conversations</p>
        {onClose && (
          <button type="button" onClick={onClose} className="grid size-8 place-items-center text-faint hover:text-ink" aria-label="Close conversation history">
            <X className="size-4" />
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <p className="px-2 py-3 text-xs leading-relaxed text-faint">Your saved conversations will appear here.</p>
        ) : (
          <div className="space-y-0.5">
            {threads.map((thread) => {
              const active = thread.id === activeThreadId;
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => onSelect(thread.id)}
                  disabled={disabled}
                  aria-current={active ? "true" : undefined}
                  className={`w-full rounded-[2px] px-2.5 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                    active ? "bg-surface-2 text-ink-strong" : "text-muted hover:bg-surface-2 hover:text-ink"
                  }`}
                >
                  <span className="block truncate text-[0.75rem] font-medium">{thread.title}</span>
                  <span className="mt-0.5 block text-[0.625rem] text-faint">{conversationDate(thread.updatedAt)} · {thread.messageCount} messages</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </>
  );
}

function conversationDate(iso: string): string {
  const date = new Date(iso);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function SegmentView({ segment }: { segment: Segment }) {
  if (segment.kind === "text") return <CoachMessage text={segment.text} />;
  if (segment.kind === "notice") {
    return (
      <p className="flex items-start gap-1.5 rounded-[2px] border border-border-soft bg-surface px-2.5 py-1.5 text-xs text-muted">
        <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
        <span>{segment.message}</span>
      </p>
    );
  }
  return (
    <div className="flex flex-wrap gap-1.5">
      {segment.items.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border-soft bg-surface px-2.5 py-1 text-[0.6875rem] text-muted"
          title={chip.summary || chip.label}
        >
          {chip.status === "running" ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-faint" aria-label="running" />
          ) : chip.status === "ok" ? (
            <Check className="size-3 shrink-0 text-success" aria-label="done" />
          ) : (
            <X className="size-3 shrink-0 text-danger" aria-label="failed" />
          )}
          <span className="truncate">
            {chip.label}
            {chip.status !== "running" && chip.summary ? <span className="text-faint"> · {chip.summary}</span> : null}
          </span>
        </span>
      ))}
    </div>
  );
}

function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-1 text-faint" aria-label="Coach is thinking">
      <span className="anim-thinking size-1.5 rounded-full bg-current [animation-delay:-0.26s]" />
      <span className="anim-thinking size-1.5 rounded-full bg-current [animation-delay:-0.13s]" />
      <span className="anim-thinking size-1.5 rounded-full bg-current" />
    </span>
  );
}

/* Markdown-lite renderer for the coach's bold, code, bullets, and headings. */
function CoachMessage({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (!list.length) return;
    const items = list.slice();
    blocks.push(
      <ul key={`ul-${key++}`} className="my-1.5 space-y-1 pl-1">
        {items.map((item, index) => (
          <li key={index} className="flex gap-2">
            <span className="mt-2 size-1 shrink-0 rounded-full bg-faint" />
            <span>{inline(item)}</span>
          </li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    const heading = line.match(/^#{1,3}\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
    } else if (heading) {
      flushList();
      blocks.push(
        <p key={`h-${key++}`} className="mb-1 mt-2.5 font-semibold text-ink first:mt-0">
          {inline(heading[1])}
        </p>,
      );
    } else if (line.trim() === "") {
      flushList();
    } else {
      flushList();
      blocks.push(
        <p key={`p-${key++}`} className="my-1.5 first:mt-0 last:mb-0">
          {inline(line)}
        </p>,
      );
    }
  }
  flushList();

  return <div className="text-pretty">{blocks}</div>;
}

/** Inline formatting: **bold** and `code`. */
function inline(text: string): ReactNode {
  const parts: ReactNode[] = [];
  const regex = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    if (match[2] !== undefined) {
      parts.push(
        <strong key={key++} className="font-semibold text-ink">
          {match[2]}
        </strong>,
      );
    } else if (match[3] !== undefined) {
      parts.push(
        <code key={key++} className="tabular rounded-[2px] bg-surface-2 px-1 py-0.5 text-[0.85em] text-ink-strong">
          {match[3]}
        </code>,
      );
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}
