import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import nodemailer from "nodemailer";
import { renderPortalOtpEmail, renderPortalInvitationEmail } from "./templates";
import {
  sendPortalOtpEmail,
  sendPortalInvitationEmail,
  emailDeliveryLog,
  isEmailConfigured,
  getSenderEmail,
} from "./provider";

function clearEmailEnv(): void {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.PAYROOST_EMAIL_FROM;
}


describe("Phase 3B.2.1: Client Portal OTP Email Template & Dispatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    emailDeliveryLog.length = 0;
    clearEmailEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    emailDeliveryLog.length = 0;
    clearEmailEnv();
  });

  // ==========================================================================
  // 1. Template Rendering
  // ==========================================================================
  describe("renderPortalOtpEmail", () => {
    it("renders email with prominent OTP code and accurate expiry duration", () => {
      const email = renderPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Website Redesign",
        otpCode: "847291",
        expiresInMinutes: 15,
      });

      expect(email.subject).toContain("847291");
      expect(email.subject).toContain("Payroost Client Portal verification code");

      // Plain text verification
      expect(email.text).toContain("847291");
      expect(email.text).toContain("Website Redesign");
      expect(email.text).toContain("15 minutes");
      expect(email.text).toContain("If you did not request access to this portal, please disregard this email.");

      // HTML verification
      expect(email.html).toContain("847291");
      expect(email.html).toContain("Website Redesign");
      expect(email.html).toContain("15 minutes");
      expect(email.html).toContain("Access your client payment portal");
      expect(email.html).toContain("Portal Verification Code");
    });

    it("ensures no raw tokens, HMACs, or session secrets are present in rendered output", () => {
      const email = renderPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Security Audit",
        otpCode: "123456",
      });

      const combined = `${email.subject} ${email.text} ${email.html}`;

      // Assert no secret patterns or placeholders
      expect(combined).not.toContain("token_hash");
      expect(combined).not.toContain("session_token");
      expect(combined).not.toContain("csrf_secret");
      expect(combined).not.toContain("otp_hmac");
      expect(combined).not.toContain("eyJ"); // JWT prefix
    });

    it("supports custom expiry durations accurately", () => {
      const email = renderPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Quick Task",
        otpCode: "654321",
        expiresInMinutes: 10,
      });

      expect(email.text).toContain("10 minutes");
      expect(email.html).toContain("10 minutes");
    });
  });

  // ==========================================================================
  // 2. Dispatch Logic & Destination Validation
  // ==========================================================================
  describe("sendPortalOtpEmail", () => {
    it("rejects invalid or empty destination email addresses", async () => {
      const resultNoEmail = await sendPortalOtpEmail({
        clientEmail: "",
        projectTitle: "Project",
        otpCode: "123456",
      });
      expect(resultNoEmail.success).toBe(false);
      expect(resultNoEmail.error).toMatch(/INVALID_DESTINATION_EMAIL/);

      const resultInvalidEmail = await sendPortalOtpEmail({
        clientEmail: "invalid-email-string",
        projectTitle: "Project",
        otpCode: "123456",
      });
      expect(resultInvalidEmail.success).toBe(false);
      expect(resultInvalidEmail.error).toMatch(/INVALID_DESTINATION_EMAIL/);
    });

    it("rejects invalid OTP codes (non-numeric or wrong length)", async () => {
      const resultNonNumeric = await sendPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        otpCode: "abcdef",
      });
      expect(resultNonNumeric.success).toBe(false);
      expect(resultNonNumeric.error).toMatch(/INVALID_OTP_CODE/);

      const resultShort = await sendPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        otpCode: "12345",
      });
      expect(resultShort.success).toBe(false);
      expect(resultShort.error).toMatch(/INVALID_OTP_CODE/);
    });

    it("captures sent email in test-mode delivery log without leaking body secrets", async () => {
      // In test mode without SMTP credentials, sendEmail pushes to emailDeliveryLog
      const result = await sendPortalOtpEmail({
        clientEmail: "verified-client@acme.corp",
        projectTitle: "SaaS Platform",
        otpCode: "998877",
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe("test-mock-id");

      expect(emailDeliveryLog).toHaveLength(1);
      expect(emailDeliveryLog[0].to).toBe("verified-client@acme.corp");
      expect(emailDeliveryLog[0].subject).toContain("Payroost Client Portal verification code");
      // emailDeliveryLog stores only { to, subject } - does not store text/html body or tokens
      expect(emailDeliveryLog[0]).not.toHaveProperty("html");
      expect(emailDeliveryLog[0]).not.toHaveProperty("text");
    });
  });

  // ==========================================================================
  // Phase 3B.2.3: Portal Invitation Email Template & Dispatch
  // ==========================================================================
  describe("Phase 3B.2.3: Portal Invitation Email", () => {
    it("renders invitation email with project title, portal link, and 7-day expiry", () => {
      const email = renderPortalInvitationEmail({
        clientName: "Jane Doe",
        projectTitle: "Brand Overhaul",
        portalUrl: "https://payroost.dev/portal/test-raw-portal-token-xyz",
        expiresInDays: 7,
      });

      expect(email.subject).toBe('Access your client portal for "Brand Overhaul" on Payroost');
      expect(email.text).toContain("Jane Doe");
      expect(email.text).toContain("Brand Overhaul");
      expect(email.text).toContain("https://payroost.dev/portal/test-raw-portal-token-xyz");
      expect(email.text).toContain("7 days");
      expect(email.text).toContain("If you did not expect this email, you may safely disregard it.");

      expect(email.html).toContain("Jane Doe");
      expect(email.html).toContain("Brand Overhaul");
      expect(email.html).toContain("https://payroost.dev/portal/test-raw-portal-token-xyz");
      expect(email.html).toContain("7 days");
      expect(email.html).toContain("Access Client Portal");
    });

    it("safely escapes HTML characters in client name and project title", () => {
      const email = renderPortalInvitationEmail({
        clientName: "<script>alert('xss')</script>",
        projectTitle: "Project & 'Test' <Escaped>",
        portalUrl: "https://payroost.dev/portal/token123",
      });

      expect(email.html).not.toContain("<script>");
      expect(email.html).toContain("&lt;script&gt;alert(&#039;xss&#039;)&lt;/script&gt;");
      expect(email.html).toContain("Project &amp; &#039;Test&#039; &lt;Escaped&gt;");
    });

    it("dispatches portal invitation email and validates inputs", async () => {
      const invalidEmail = await sendPortalInvitationEmail({
        clientEmail: "invalid-email",
        projectTitle: "Project",
        portalUrl: "https://payroost.dev/portal/123",
      });
      expect(invalidEmail.success).toBe(false);
      expect(invalidEmail.error).toContain("INVALID_DESTINATION_EMAIL");

      const invalidUrl = await sendPortalInvitationEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        portalUrl: "/relative/path",
      });
      expect(invalidUrl.success).toBe(false);
      expect(invalidUrl.error).toContain("INVALID_PORTAL_URL");

      const validResult = await sendPortalInvitationEmail({
        clientEmail: "client@example.com",
        clientName: "Jane",
        projectTitle: "Project",
        portalUrl: "https://payroost.dev/portal/123",
      });
      expect(validResult.success).toBe(true);
      expect(emailDeliveryLog).toContainEqual({
        to: "client@example.com",
        subject: 'Access your client portal for "Project" on Payroost',
      });
    });
  });

  // ==========================================================================
  // Gmail SMTP Delivery & Configuration Validation
  // ==========================================================================
  describe("Gmail SMTP & Configuration", () => {
    it("dispatches via Gmail SMTP defaults when SMTP_USER and SMTP_PASS are set", async () => {
      process.env.SMTP_USER = "freelancer@gmail.com";
      process.env.SMTP_PASS = "abcd efgh ijkl mnop";

      const sendMailMock = vi.fn().mockResolvedValue({ messageId: "<smtp-msg-1@gmail.com>" });
      const createTransportSpy = vi.spyOn(nodemailer, "createTransport").mockReturnValue({
        sendMail: sendMailMock,
      } as never);

      expect(isEmailConfigured()).toBe(true);
      expect(getSenderEmail()).toBe("Payroost <freelancer@gmail.com>");

      const result = await sendPortalOtpEmail({
        clientEmail: "client@anydomain.com",
        projectTitle: "Website Build",
        otpCode: "654321",
        expiresInMinutes: 15,
      });

      expect(result.success).toBe(true);
      expect(result.messageId).toBe("<smtp-msg-1@gmail.com>");
      expect(createTransportSpy).toHaveBeenCalledWith({
        host: "smtp.gmail.com",
        port: 465,
        secure: true,
        auth: {
          user: "freelancer@gmail.com",
          pass: "abcdefghijklmnop",
        },
      });
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Payroost <freelancer@gmail.com>",
          to: "client@anydomain.com",
        })
      );
      expect(emailDeliveryLog).toHaveLength(0);
    });

    it("supports custom SMTP_HOST, SMTP_PORT, SMTP_SECURE, and PAYROOST_EMAIL_FROM", async () => {
      process.env.SMTP_HOST = "smtp.custommail.test";
      process.env.SMTP_PORT = "587";
      process.env.SMTP_SECURE = "false";
      process.env.SMTP_USER = "notify@custommail.test";
      process.env.SMTP_PASS = "pass with spaces";
      process.env.PAYROOST_EMAIL_FROM = "Payroost Billing <billing@custommail.test>";

      const sendMailMock = vi.fn().mockResolvedValue({ messageId: "<custom-1>" });
      const createTransportSpy = vi.spyOn(nodemailer, "createTransport").mockReturnValue({
        sendMail: sendMailMock,
      } as never);

      const result = await sendPortalInvitationEmail({
        clientEmail: "client@example.com",
        projectTitle: "Retainer",
        portalUrl: "https://payroost.dev/portal/abc",
      });

      expect(result.success).toBe(true);
      expect(createTransportSpy).toHaveBeenCalledWith({
        host: "smtp.custommail.test",
        port: 587,
        secure: false,
        auth: {
          user: "notify@custommail.test",
          pass: "pass with spaces",
        },
      });
      expect(sendMailMock).toHaveBeenCalledWith(
        expect.objectContaining({
          from: "Payroost Billing <billing@custommail.test>",
          to: "client@example.com",
        })
      );
    });

    it("returns misconfigured error when SMTP_USER is set without SMTP_PASS", async () => {
      process.env.SMTP_USER = "freelancer@gmail.com";

      expect(isEmailConfigured()).toBe(false);

      const result = await sendPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        otpCode: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("EMAIL_PROVIDER_MISCONFIGURED");
    });

    it("rejects invalid SMTP_PORT or SMTP_SECURE settings cleanly", async () => {
      process.env.SMTP_USER = "freelancer@gmail.com";
      process.env.SMTP_PASS = "abcdefghijklmnop";
      process.env.SMTP_PORT = "not-a-port";

      expect(isEmailConfigured()).toBe(false);

      const badPortResult = await sendPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        otpCode: "123456",
      });
      expect(badPortResult.success).toBe(false);
      expect(badPortResult.error).toContain("EMAIL_PROVIDER_MISCONFIGURED");

      process.env.SMTP_PORT = "465";
      process.env.SMTP_SECURE = "invalid";

      const badSecureResult = await sendPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        otpCode: "123456",
      });
      expect(badSecureResult.success).toBe(false);
      expect(badSecureResult.error).toContain("EMAIL_PROVIDER_MISCONFIGURED");
    });

    it("redacts SMTP_PASS from error messages on authentication or transport failure", async () => {
      process.env.SMTP_USER = "freelancer@gmail.com";
      process.env.SMTP_PASS = "abcd efgh ijkl mnop";

      const sendMailMock = vi
        .fn()
        .mockRejectedValue(
          new Error("Invalid login using abcd efgh ijkl mnop / abcdefghijklmnop for user")
        );
      vi.spyOn(nodemailer, "createTransport").mockReturnValue({
        sendMail: sendMailMock,
      } as never);

      const result = await sendPortalOtpEmail({
        clientEmail: "client@example.com",
        projectTitle: "Project",
        otpCode: "123456",
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain("EMAIL_SEND_FAILED");
      expect(result.error).not.toContain("abcdefghijklmnop");
      expect(result.error).not.toContain("abcd efgh ijkl mnop");
    });
  });
});

