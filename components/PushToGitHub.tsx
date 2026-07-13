"use client";

import { useState, useTransition } from "react";
import { Github, Check, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui";
import { pushProgramToGitHub } from "@/app/actions";

/**
 * "Save to GitHub" — pushes the website's source-of-truth program to GitHub,
 * where the daily analysis Action reads it. The website is the source of truth;
 * this is the website → GitHub hop.
 */
export function PushToGitHub() {
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2.5">
      {result && (
        <span
          className={`inline-flex items-center gap-1.5 text-xs ${result.ok ? "text-success" : "text-danger"}`}
        >
          {result.ok ? <Check className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
          <span className="max-w-full truncate sm:max-w-[22rem]">{result.message}</span>
        </span>
      )}
      <Button
        variant="secondary"
        size="sm"
        disabled={pending}
        onClick={() => {
          setResult(null);
          start(async () => setResult(await pushProgramToGitHub()));
        }}
        title="Commit and push your program (the source of truth) to GitHub"
      >
        <Github className="size-3.5" />
        {pending ? "Pushing…" : "Save to GitHub"}
      </Button>
    </div>
  );
}
