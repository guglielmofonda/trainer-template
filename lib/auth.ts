export const AUTH_COOKIE = "trainer_session";
export const AUTH_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const DEFAULT_RETURN_PATH = "/configuration";

function configuredPassword(): string {
  return process.env.APP_PASSWORD?.trim() ?? "";
}

function sessionSecret(): string {
  return process.env.APP_SESSION_SECRET?.trim() || configuredPassword();
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function hmacSha256(value: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

export function safeEqual(left = "", right = ""): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export function isPasswordGateConfigured(): boolean {
  return configuredPassword().length > 0;
}

export function isPasswordGateRequired(): boolean {
  return isPasswordGateConfigured() || process.env.VERCEL === "1";
}

export async function isPasswordValid(password: string): Promise<boolean> {
  const expected = configuredPassword();
  return expected.length > 0 && safeEqual(password.trim(), expected);
}

export async function buildSessionToken(): Promise<string | null> {
  const password = configuredPassword();
  if (!password) return null;
  return hmacSha256("trainer-password-session", sessionSecret());
}

export async function isValidSessionToken(token?: string): Promise<boolean> {
  if (!token) return false;
  const expected = await buildSessionToken();
  return expected !== null && safeEqual(token, expected);
}

export function normalizeReturnPath(value?: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    return DEFAULT_RETURN_PATH;
  }
  return value;
}
