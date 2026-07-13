import { afterEach, describe, expect, it } from "vitest";
import {
  buildSessionToken,
  isPasswordGateConfigured,
  isPasswordGateRequired,
  isPasswordValid,
  isValidSessionToken,
  normalizeReturnPath,
} from "./auth";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("auth helpers", () => {
  it("normalizes return paths to same-origin app paths", () => {
    expect(normalizeReturnPath("/program?week=2")).toBe("/program?week=2");
    expect(normalizeReturnPath("https://example.com")).toBe("/configuration");
    expect(normalizeReturnPath("//example.com")).toBe("/configuration");
    expect(normalizeReturnPath("")).toBe("/configuration");
  });

  it("requires the gate on Vercel even before the password is configured", () => {
    delete process.env.APP_PASSWORD;
    process.env.VERCEL = "1";

    expect(isPasswordGateConfigured()).toBe(false);
    expect(isPasswordGateRequired()).toBe(true);
  });

  it("validates passwords and signed session tokens", async () => {
    process.env.APP_PASSWORD = "correct horse battery staple";
    process.env.APP_SESSION_SECRET = "session signing secret";

    await expect(isPasswordValid("correct horse battery staple")).resolves.toBe(true);
    await expect(isPasswordValid("wrong")).resolves.toBe(false);

    const token = await buildSessionToken();
    expect(token).toBeTruthy();
    await expect(isValidSessionToken(token ?? "")).resolves.toBe(true);
    await expect(isValidSessionToken("invalid")).resolves.toBe(false);
  });
});
