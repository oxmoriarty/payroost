import "server-only";
import nodemailer from "nodemailer";
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

interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  rawPass: string;
}

type SmtpConfigResolution =
  | { status: "unconfigured" }
  | { status: "invalid"; error: string }
  | { status: "configured"; config: SmtpConfig };

const GMAIL_APP_PASSWORD_PATTERN = /^[a-z]{4}(\s+[a-z]{4}){3}$/i;

function normalizeSmtpPassword(host: string, rawTrimmed: string): string {
  // Google displays 16-character App Passwords in four space-separated groups.
  if (host.toLowerCase() === "smtp.gmail.com" && GMAIL_APP_PASSWORD_PATTERN.test(rawTrimmed)) {
    return rawTrimmed.replace(/\s+/g, "");
  }
  return rawTrimmed;
}

function resolveSmtpConfig(): SmtpConfigResolution {
  const user = process.env.SMTP_USER?.trim() ?? "";
  const rawPass = process.env.SMTP_PASS?.trim() ?? "";

  if (!user && !rawPass) {
    return { status: "unconfigured" };
  }

  if (!user || !rawPass) {
    return {
      status: "invalid",
      error: "EMAIL_PROVIDER_MISCONFIGURED: Both SMTP_USER and SMTP_PASS are required when configuring SMTP.",
    };
  }

  const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  const rawPort = process.env.SMTP_PORT?.trim();
  let port = 465;
  if (rawPort) {
    if (!/^\d+$/.test(rawPort)) {
      return {
        status: "invalid",
        error: "EMAIL_PROVIDER_MISCONFIGURED: SMTP_PORT must be a valid port number (1-65535).",
      };
    }
    port = Number(rawPort);
    if (port < 1 || port > 65535) {
      return {
        status: "invalid",
        error: "EMAIL_PROVIDER_MISCONFIGURED: SMTP_PORT must be a valid port number (1-65535).",
      };
    }
  }

  const rawSecure = process.env.SMTP_SECURE?.trim().toLowerCase();
  let secure = port === 465;
  if (rawSecure) {
    if (rawSecure === "true") {
      secure = true;
    } else if (rawSecure === "false") {
      secure = false;
    } else {
      return {
        status: "invalid",
        error: "EMAIL_PROVIDER_MISCONFIGURED: SMTP_SECURE must be 'true' or 'false'.",
      };
    }
  }

  return {
    status: "configured",
    config: {
      host,
      port,
      secure,
      user,
      pass: normalizeSmtpPassword(host, rawPass),
      rawPass,
    },
  };
}

function getResendApiKey(): string | undefined {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  return apiKey || undefined;
}

function sanitizeErrorMessage(message: string, secrets: Array<string | undefined>): string {
  let sanitized = message;
  for (const secret of secrets) {
    if (secret) {
      sanitized = sanitized.split(secret).join("[REDACTED]");
    }
  }
  return sanitized.slice(0, 200);
}

export function isEmailConfigured(): boolean {
  const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const smtp = resolveSmtpConfig();
  const resendConfigured = Boolean(getResendApiKey());

  if (provider === "smtp") {
    return smtp.status === "configured";
  }
  if (provider === "resend") {
    return resendConfigured;
  }
  if (provider) {
    return false;
  }

  return smtp.status === "configured" || resendConfigured;
}

export function getSenderEmail(): string {
  const configuredFrom = process.env.PAYROOST_EMAIL_FROM?.trim();
  if (configuredFrom) {
    return configuredFrom;
  }

  const smtp = resolveSmtpConfig();
  if (smtp.status === "configured") {
    return `Payroost <${smtp.config.user}>`;
  }

  return "Payroost <onboarding@resend.dev>";
}

export function getAppUrl(): string {
  const url = process.env.PAYROOST_APP_URL || process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
  return url.replace(/\/$/, "");
}

async function sendViaSmtp(
  config: SmtpConfig,
  from: string,
  params: SendEmailParams
): Promise<EmailDeliveryResult> {
  try {
    const transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.user,
        pass: config.pass,
      },
    });

    const info = await transporter.sendMail({
      from,
      to: params.to,
      subject: params.subject,
      html: params.html,
      text: params.text,
    });

    return { success: true, messageId: info.messageId };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Unknown SMTP email dispatch failure";
    return {
      success: false,
      error: `EMAIL_SEND_FAILED: ${sanitizeErrorMessage(rawMessage, [config.pass, config.rawPass])}`,
    };
  }
}

async function sendViaResend(
  apiKey: string,
  from: string,
  params: SendEmailParams
): Promise<EmailDeliveryResult> {
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
        error: `EMAIL_SEND_FAILED (${response.status}): ${sanitizeErrorMessage(errorData, [apiKey])}`,
      };
    }

    const data = (await response.json()) as { id?: string };
    return { success: true, messageId: data.id };
  } catch (err) {
    const rawMessage = err instanceof Error ? err.message : "Unknown email dispatch failure";
    return {
      success: false,
      error: sanitizeErrorMessage(rawMessage, [apiKey]),
    };
  }
}

export async function sendEmail(params: SendEmailParams): Promise<EmailDeliveryResult> {
  const provider = process.env.EMAIL_PROVIDER?.trim().toLowerCase();
  const smtp = resolveSmtpConfig();
  const apiKey = getResendApiKey();
  const from = getSenderEmail();

  if (provider === "smtp") {
    if (smtp.status === "invalid") {
      return { success: false, error: smtp.error };
    }
    if (smtp.status === "unconfigured") {
      return {
        success: false,
        error: "EMAIL_PROVIDER_NOT_CONFIGURED: SMTP_USER and SMTP_PASS environment variables are not set.",
      };
    }
    return sendViaSmtp(smtp.config, from, params);
  }

  if (provider === "resend") {
    if (!apiKey) {
      return {
        success: false,
        error: "EMAIL_PROVIDER_NOT_CONFIGURED: RESEND_API_KEY environment variable is not set.",
      };
    }
    return sendViaResend(apiKey, from, params);
  }

  if (provider) {
    return {
      success: false,
      error: "EMAIL_PROVIDER_MISCONFIGURED: Unsupported EMAIL_PROVIDER. Expected 'smtp' or 'resend'.",
    };
  }

  if (smtp.status === "invalid") {
    return { success: false, error: smtp.error };
  }

  if (smtp.status === "configured") {
    return sendViaSmtp(smtp.config, from, params);
  }

  if (apiKey) {
    return sendViaResend(apiKey, from, params);
  }

  // Test environment spy (without leaking secrets or tokens)
  if (process.env.NODE_ENV === "test") {
    emailDeliveryLog.push({ to: params.to, subject: params.subject });
    return { success: true, messageId: "test-mock-id" };
  }

  return {
    success: false,
    error: "EMAIL_PROVIDER_NOT_CONFIGURED: Set SMTP_USER and SMTP_PASS (Gmail SMTP) or RESEND_API_KEY.",
  };
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

