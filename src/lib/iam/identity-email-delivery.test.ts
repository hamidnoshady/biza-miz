/**
 * ESH-199 / #1384 follow-up — the email proof's link, copy and delivery outcome.
 *
 * The transport is mocked here; the real deployment uses the platform SMTP
 * singleton. These tests pin the no-transport behaviour (onboarding must still
 * be completable) and that a configured transport receives only the link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const platformBaseUrl = vi.hoisted(() => vi.fn());
const resolveMessageConfig = vi.hoisted(() => vi.fn());
const send = vi.hoisted(() => vi.fn());

vi.mock("../deployment-role", () => ({ platformBaseUrl }));
vi.mock("../messaging-billing", () => ({ resolveMessageConfig }));
vi.mock("../messaging/providers/smtp", () => ({
  SmtpMessageProvider: class {
    send(message: unknown) {
      return send(message);
    }
  },
}));

import {
  identityEmailVerificationMessage,
  identityEmailVerificationUrl,
  sendIdentityEmailVerification,
} from "./identity-email-delivery";

const SMTP_CONFIG = {
  enabled: true,
  emailProvider: "smtp",
  smtp: {
    host: "smtp.example.invalid",
    port: 587,
    secure: true,
    user: "mailer",
    password: "secret",
    from: "no-reply@example.invalid",
  },
};

beforeEach(() => {
  platformBaseUrl.mockReset();
  resolveMessageConfig.mockReset();
  send.mockReset();
});

describe("the identity email verification link", () => {
  it("builds a path-safe link and refuses an install with no public URL", () => {
    expect(identityEmailVerificationUrl(null, "abc")).toBeNull();
    expect(identityEmailVerificationUrl("https://app.example/", "a b/c")).toBe(
      "https://app.example/verify/email/a%20b%2Fc",
    );
  });

  it("tells the recipient the link is single-use and time-limited", () => {
    const message = identityEmailVerificationMessage("https://app.example/verify/email/token");
    expect(message.subject).toContain("تأیید ایمیل");
    expect(message.body).toContain("https://app.example/verify/email/token");
    expect(message.body).toContain("یک‌بار مصرف");
    expect(message.body).toContain("۲۴ ساعت");
  });
});

describe("sending the identity email proof", () => {
  it("reports unavailable without a public URL or transport, without throwing", async () => {
    platformBaseUrl.mockReturnValue(null);
    expect(await sendIdentityEmailVerification({ to: "a@example.invalid", token: "x" })).toEqual({
      outcome: "unavailable",
      reason: "no_base_url",
    });
    expect(send).not.toHaveBeenCalled();

    platformBaseUrl.mockReturnValue("https://app.example");
    resolveMessageConfig.mockResolvedValue({ ...SMTP_CONFIG, enabled: false });
    expect(await sendIdentityEmailVerification({ to: "a@example.invalid", token: "x" })).toEqual({
      outcome: "unavailable",
      reason: "no_transport",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends only to the address and carries the verification link", async () => {
    platformBaseUrl.mockReturnValue("https://app.example");
    resolveMessageConfig.mockResolvedValue(SMTP_CONFIG);
    send.mockResolvedValue({ ok: true, providerMessageId: "smtp:1", segments: 1 });

    const result = await sendIdentityEmailVerification({
      to: "person@example.invalid",
      token: "opaque-token",
    });
    expect(result).toEqual({ outcome: "sent" });
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0] as { to: string; subject: string; body: string };
    expect(message.to).toBe("person@example.invalid");
    expect(message.body).toContain("https://app.example/verify/email/opaque-token");
  });

  it("turns a provider failure into a recoverable failed outcome", async () => {
    platformBaseUrl.mockReturnValue("https://app.example");
    resolveMessageConfig.mockResolvedValue(SMTP_CONFIG);
    send.mockResolvedValue({ ok: false, retryable: true, code: "network", message: "down" });

    expect(await sendIdentityEmailVerification({ to: "a@example.invalid", token: "x" })).toEqual({
      outcome: "failed",
      reason: "send_failed",
    });
  });
});
