import "server-only";
import {
  renderClientVerificationEmail,
  renderReviewOtpEmail,
  renderPortalOtpEmail,
  renderPortalInvitationEmail,
} from "./templates";


export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface EmailDeliveryResult {
  success: boolean;
  error?: string;
  messageId?: string;
}

// In-memory test spy for integration tests
export const emailDeliveryLog: Array<{ to: string; subject: string }> = [];

export function isEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_API_KEY.trim());
}

export function getSenderEmail(): string {
  return process.env.PAYROOST_EMAIL_FROM?.trim() || "Payroost <onboarding@resend.dev>";
}

export function getAppUrl(): string {
  const url = process.env.PAYROOST_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return url.replace(/\/$/, "");
}

export async function sendEmail(params: SendEmailParams): Promise<EmailDeliveryResult> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = getSenderEmail();

  // Test environment spy (without leaking secrets or tokens)
  if (process.env.NODE_ENV === "test" && !apiKey) {
    emailDeliveryLog.push({ to: params.to, subject: params.subject });
    return { success: true, messageId: "test-mock-id" };
  }

  if (!apiKey) {
    return {
      success: false,
      error: "EMAIL_PROVIDER_NOT_CONFIGURED: RESEND_API_KEY environment variable is not set.",
    };
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    });

    if (!response.ok) {
      const errorData = await response.text();
      return {
        success: false,
        error: `EMAIL_SEND_FAILED (${response.status}): ${errorData.slice(0, 200)}`,
      };
    }

    const data = (await response.json()) as { id?: string };
    return { success: true, messageId: data.id };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Unknown email dispatch failure",
    };
  }
}

export async function sendClientVerificationEmail(params: {
  clientEmail: string;
  clientName: string;
  projectTitle: string;
  verificationToken: string;
}): Promise<EmailDeliveryResult> {
  const appUrl = getAppUrl();
  const verificationUrl = `${appUrl}/verify-client-email?token=${params.verificationToken}`;
  const template = renderClientVerificationEmail({
    clientName: params.clientName,
    projectTitle: params.projectTitle,
    verificationUrl,
  });

  return sendEmail({
    to: params.clientEmail,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}

export async function sendReviewOtpEmail(params: {
  clientEmail: string;
  projectTitle: string;
  action: "APPROVE" | "REQUEST_CHANGES";
  otpCode: string;
}): Promise<EmailDeliveryResult> {
  const template = renderReviewOtpEmail({
    projectTitle: params.projectTitle,
    action: params.action,
    otpCode: params.otpCode,
    expiresInMinutes: 15,
  });

  return sendEmail({
    to: params.clientEmail,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}

export async function sendPortalOtpEmail(params: {
  clientEmail: string;
  projectTitle: string;
  otpCode: string;
  expiresInMinutes?: number;
}): Promise<EmailDeliveryResult> {
  const to = params.clientEmail?.trim();
  if (!to || !to.includes("@")) {
    return {
      success: false,
      error: "INVALID_DESTINATION_EMAIL: A valid recipient email is required.",
    };
  }

  if (!params.otpCode || !/^\d{6}$/.test(params.otpCode.trim())) {
    return {
      success: false,
      error: "INVALID_OTP_CODE: A 6-digit OTP code is required.",
    };
  }

  const template = renderPortalOtpEmail({
    clientEmail: to,
    projectTitle: params.projectTitle?.trim() || "Project Portal",
    otpCode: params.otpCode.trim(),
    expiresInMinutes: params.expiresInMinutes ?? 15,
  });

  return sendEmail({
    to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}

export async function sendPortalInvitationEmail(params: {
  clientEmail: string;
  clientName?: string;
  projectTitle: string;
  portalUrl: string;
  expiresInDays?: number;
}): Promise<EmailDeliveryResult> {
  const to = params.clientEmail?.trim();
  if (!to || !to.includes("@")) {
    return {
      success: false,
      error: "INVALID_DESTINATION_EMAIL: A valid recipient email is required.",
    };
  }

  if (!params.portalUrl || !params.portalUrl.startsWith("http")) {
    return {
      success: false,
      error: "INVALID_PORTAL_URL: A valid absolute URL is required.",
    };
  }

  const template = renderPortalInvitationEmail({
    clientName: params.clientName,
    projectTitle: params.projectTitle?.trim() || "Project Portal",
    portalUrl: params.portalUrl,
    expiresInDays: params.expiresInDays ?? 7,
  });

  return sendEmail({
    to,
    subject: template.subject,
    html: template.html,
    text: template.text,
  });
}

