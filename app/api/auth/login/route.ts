import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_COOKIE,
  AUTH_MAX_AGE_SECONDS,
  buildSessionToken,
  isPasswordGateConfigured,
  isPasswordValid,
  normalizeReturnPath,
} from "@/lib/auth";

function loginRedirect(request: NextRequest, error: "invalid" | "config", next: string): NextResponse {
  const url = new URL("/login", request.url);
  url.searchParams.set("error", error);
  url.searchParams.set("next", next);
  return NextResponse.redirect(url, { status: 303 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const form = await request.formData();
  const next = normalizeReturnPath(String(form.get("next") ?? ""));
  const password = String(form.get("password") ?? "");

  if (!isPasswordGateConfigured()) {
    return loginRedirect(request, "config", next);
  }
  if (!(await isPasswordValid(password))) {
    return loginRedirect(request, "invalid", next);
  }

  const token = await buildSessionToken();
  if (!token) {
    return loginRedirect(request, "config", next);
  }

  const response = NextResponse.redirect(new URL(next, request.url), { status: 303 });
  response.cookies.set(AUTH_COOKIE, token, {
    httpOnly: true,
    maxAge: AUTH_MAX_AGE_SECONDS,
    path: "/",
    sameSite: "lax",
    secure: process.env.VERCEL === "1",
  });
  return response;
}

export function GET(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/login", request.url));
}
