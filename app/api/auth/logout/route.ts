import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth";

export function POST(request: NextRequest): NextResponse {
  const response = NextResponse.redirect(new URL("/login", request.url), { status: 303 });
  response.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    maxAge: 0,
    path: "/",
    sameSite: "lax",
    secure: process.env.VERCEL === "1",
  });
  return response;
}

export function GET(request: NextRequest): NextResponse {
  return NextResponse.redirect(new URL("/login", request.url));
}
