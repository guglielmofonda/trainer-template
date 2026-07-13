import type { Metadata } from "next";
import { cookies } from "next/headers";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import { Fraunces } from "next/font/google";
import "./globals.css";

// Editorial display voice — serif authority for titles and the brand.
const serifDisplay = Fraunces({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  style: ["normal"],
  variable: "--font-serif-display",
  display: "swap",
});
import { Sidebar } from "@/components/Sidebar";
import { hasCoachKey } from "@/lib/coach/coach";
import { AUTH_COOKIE, isPasswordGateRequired, isValidSessionToken } from "@/lib/auth";
import { getProfile } from "@/lib/profile";

export function generateMetadata(): Metadata {
  const profile = getProfile();
  return {
    title: `${profile.appName} — progressive overload`,
    applicationName: profile.appName,
    icons: {
      icon: "/icon.svg",
    },
    description: `${profile.appName} is a progressive-overload, periodized strength-training platform. The periodization + autoregulated-progression engine is the core.`,
  };
}

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const profile = getProfile();
  const cookieStore = await cookies();
  const showAppShell =
    !isPasswordGateRequired() || (await isValidSessionToken(cookieStore.get(AUTH_COOKIE)?.value));

  return (
    <html
      lang="en"
      className={`${GeistSans.variable} ${GeistMono.variable} ${serifDisplay.variable}`}
    >
      <body>
        <div className="flex h-dvh flex-col overflow-hidden md:flex-row">
          {showAppShell && (
            <Sidebar
              coachOnline={hasCoachKey()}
              appName={profile.appName}
              monogram={profile.monogram}
              tagline={profile.tagline}
            />
          )}
          <main className="min-h-0 min-w-0 flex-1 overflow-y-auto">{children}</main>
        </div>
      </body>
    </html>
  );
}
