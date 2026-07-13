import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_COOKIE,
  isPasswordGateRequired,
  isValidSessionToken,
  normalizeReturnPath,
} from "@/lib/auth";

const PUBLIC_PREFIXES = [
  "/_next",
  "/icon.svg",
  "/favicon.ico",
  "/login",
  "/api/auth",
  "/api/hevy/webhook",
];

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname) || !isPasswordGateRequired()) {
    return NextResponse.next();
  }

  const token = request.cookies.get(AUTH_COOKIE)?.value;
  if (await isValidSessionToken(token)) {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", normalizeReturnPath(`${pathname}${search}`));
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
