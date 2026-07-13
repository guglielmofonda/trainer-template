import Link from "next/link";
import { ArrowRight, LockKeyhole, ShieldAlert } from "lucide-react";
import { BrandMark, Button, Panel } from "@/components/ui";
import {
  isPasswordGateConfigured,
  isPasswordGateRequired,
  normalizeReturnPath,
} from "@/lib/auth";
import { getProfile } from "@/lib/profile";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = (await searchParams) ?? {};
  const next = normalizeReturnPath(firstParam(params.next));
  const error = firstParam(params.error);
  const configured = isPasswordGateConfigured();
  const required = isPasswordGateRequired();
  const disabled = required && !configured;
  const profile = getProfile();

  return (
    <main className="grid min-h-dvh place-items-center px-4 py-8">
      <Panel lit className="w-full max-w-[420px] overflow-hidden">
        <div className="border-b border-border-soft px-5 py-5">
          <div className="flex items-center gap-3">
            <span className="grid size-10 place-items-center rounded-lg bg-surface-2 text-accent ring-1 ring-inset ring-border-soft">
              <BrandMark className="size-6" monogram={profile.monogram} />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">{profile.appName}</h1>
              <p className="text-[0.8125rem] text-muted">Password required</p>
            </div>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          {disabled ? (
            <div className="flex items-start gap-2 rounded-md border border-danger/35 bg-danger/12 px-3 py-2 text-sm text-ink">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <p>Set APP_PASSWORD in Vercel before this deployment can accept logins.</p>
            </div>
          ) : (
            <form action="/api/auth/login" method="post" className="space-y-3">
              <input type="hidden" name="next" value={next} />
              <label className="block">
                <span className="mb-1.5 block text-[0.6875rem] font-medium uppercase tracking-wide text-faint">
                  Password
                </span>
                <input
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  autoFocus
                  required
                  className="h-10 w-full rounded-md border border-border bg-surface-2 px-3 text-sm text-ink outline-none transition-colors placeholder:text-faint focus:border-accent"
                  placeholder="Enter site password"
                />
              </label>

              {error === "invalid" && (
                <p className="rounded-md border border-danger/35 bg-danger/12 px-3 py-2 text-xs text-ink">
                  That password did not match.
                </p>
              )}

              <Button type="submit" variant="primary" className="w-full">
                <LockKeyhole className="size-4" />
                Unlock
              </Button>
            </form>
          )}

          {!required && (
            <Link
              href="/configuration"
              className="inline-flex h-10 w-full items-center justify-center gap-2 rounded-md border border-border bg-surface-2 px-4 text-sm text-ink transition-colors hover:bg-surface-3"
            >
              Continue to app
              <ArrowRight className="size-4" />
            </Link>
          )}
        </div>
      </Panel>
    </main>
  );
}
