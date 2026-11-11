import "server-only";

export function renderClientVerificationEmail(params: {
  clientName: string;
  projectTitle: string;
  verificationUrl: string;
}) {
  const { clientName, projectTitle, verificationUrl } = params;
  const subject = `Verify your email for "${projectTitle}" on Payroost`;

  const text = [
    `Hello ${clientName},`,
    "",
    `A project agreement for "${projectTitle}" is being prepared on Payroost.`,
    "To ensure security and protect both parties, please verify your email address by clicking the link below:",
    "",
    verificationUrl,
    "",
    "This verification link is single-use and will expire in 24 hours.",
    "Once verified, you will receive the final agreement draft to review and approve.",
    "",
    "If you did not expect this email, no action is required.",
    "",
    "— The Payroost Team",
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
    .card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 36px; }
    .logo { font-size: 20px; font-weight: 800; color: #0f766e; text-transform: uppercase; letter-spacing: 0.1em; }
    h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 20px; }
    p { font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 20px; }
    .btn { display: inline-block; background-color: #0f766e; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; padding: 12px 28px; border-radius: 10px; margin: 12px 0 24px; }
    .footer { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Payroost</div>
    <h1>Verify your client email address</h1>
    <p>Hello <strong>${clientName}</strong>,</p>
    <p>A project agreement for <strong>${projectTitle}</strong> has been initialized on Payroost. To ensure security and enable agreement review, please verify your email address below.</p>
    <div style="text-align: center;">
      <a href="${verificationUrl}" class="btn">Verify Client Email</a>
    </div>
    <p style="font-size: 13px; color: #64748b;">This verification link will expire in 24 hours and can only be used once. If the button above does not work, copy and paste this link into your browser:</p>
    <p style="font-size: 12px; word-break: break-all; color: #0f766e;">${verificationUrl}</p>
    <div class="footer">
      Payroost — AI-assisted freelance agreements and verified milestone workflows.<br>
      If you did not anticipate this project agreement, you may safely disregard this message.
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

export function renderReviewOtpEmail(params: {
  projectTitle: string;
  action: "APPROVE" | "REQUEST_CHANGES";
  otpCode: string;
  expiresInMinutes?: number;
}) {
  const { projectTitle, action, otpCode, expiresInMinutes = 15 } = params;
  const actionLabel = action === "APPROVE" ? "approve the agreement" : "request changes to the agreement";
  const subject = `Your Payroost confirmation code: ${otpCode}`;

  const text = [
    `Your Payroost authorization code is: ${otpCode}`,
    "",
    `This code confirms your decision to ${actionLabel} for "${projectTitle}".`,
    "",
    `This code will expire in ${expiresInMinutes} minutes and can only be used once.`,
    "Never share this code with anyone, including the freelancer.",
    "",
    "If you did not request this decision, please disregard this email.",
    "",
    "— The Payroost Team",
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 36px; }
    .logo { font-size: 20px; font-weight: 800; color: #0f766e; text-transform: uppercase; letter-spacing: 0.1em; }
    h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 16px; }
    p { font-size: 15px; line-height: 1.6; color: #334155; }
    .otp-box { background: #f0fdfa; border: 2px dashed #0f766e; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0; }
    .otp-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 800; letter-spacing: 0.25em; color: #0f766e; }
    .warning { font-size: 13px; color: #b45309; background: #fffbeb; border-radius: 8px; padding: 10px; margin-top: 16px; }
    .footer { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Payroost</div>
    <h1>Confirm your agreement decision</h1>
    <p>You requested to <strong>${actionLabel}</strong> for <strong>${projectTitle}</strong>.</p>
    <div class="otp-box">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: #0f766e; font-weight: 700; margin-bottom: 6px;">Confirmation Code</div>
      <div class="otp-code">${otpCode}</div>
    </div>
    <div class="warning">
      <strong>Security notice:</strong> This code expires in ${expiresInMinutes} minutes and can only be used once. Never share this code with anyone.
    </div>
    <div class="footer">
      Payroost Security Verification.<br>
      If you did not initiate this request, no action is needed.
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

export function renderPortalOtpEmail(params: {
  clientEmail?: string;
  projectTitle: string;
  otpCode: string;
  expiresInMinutes?: number;
}) {
  const { projectTitle, otpCode, expiresInMinutes = 15 } = params;
  const subject = `Your Payroost Client Portal verification code: ${otpCode}`;

  const text = [
    `Your Payroost verification code is: ${otpCode}`,
    "",
    `You requested access to the client payment portal for "${projectTitle}".`,
    "",
    `This verification code will expire in ${expiresInMinutes} minutes and can only be used once.`,
    "Never share this code with anyone, including the freelancer.",
    "",
    "If you did not request access to this portal, please disregard this email.",
    "",
    "— The Payroost Team",
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${subject}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
    .card { max-width: 520px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 36px; }
    .logo { font-size: 20px; font-weight: 800; color: #0f766e; text-transform: uppercase; letter-spacing: 0.1em; }
    h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin-top: 16px; }
    p { font-size: 15px; line-height: 1.6; color: #334155; }
    .otp-box { background: #f0fdfa; border: 2px dashed #0f766e; border-radius: 12px; padding: 18px; text-align: center; margin: 24px 0; }
    .otp-code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 800; letter-spacing: 0.25em; color: #0f766e; }
    .warning { font-size: 13px; color: #b45309; background: #fffbeb; border-radius: 8px; padding: 10px; margin-top: 16px; }
    .footer { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-top: 24px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Payroost</div>
    <h1>Access your client payment portal</h1>
    <p>You requested verification to access the payment portal for <strong>${projectTitle}</strong>.</p>
    <div class="otp-box">
      <div style="font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; color: #0f766e; font-weight: 700; margin-bottom: 6px;">Portal Verification Code</div>
      <div class="otp-code">${otpCode}</div>
    </div>
    <div class="warning">
      <strong>Security notice:</strong> This code expires in ${expiresInMinutes} minutes and can only be used once. Never share this code with anyone.
    </div>
    <div class="footer">
      Payroost Client Portal Verification.<br>
      If you did not initiate this request, no action is needed.
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderPortalInvitationEmail(params: {
  clientName?: string;
  projectTitle: string;
  portalUrl: string;
  expiresInDays?: number;
}) {
  const { clientName, projectTitle, portalUrl, expiresInDays = 7 } = params;
  const safeTitle = escapeHtml(projectTitle);
  const safeClientName = clientName ? escapeHtml(clientName) : "Client";
  const safePortalUrl = escapeHtml(portalUrl);
  const subject = `Access your client portal for "${projectTitle}" on Payroost`;

  const text = [
    `Hello ${clientName || "there"},`,
    "",
    `You have been invited to access the client portal for "${projectTitle}" on Payroost.`,
    "You can view project progress, agreements, and manage payments securely in your client portal.",
    "",
    "Access your client portal using the link below:",
    portalUrl,
    "",
    `This portal link will expire in ${expiresInDays} days.`,
    "For security, access requires one-time code verification sent to this email address.",
    "",
    "If you did not expect this email, you may safely disregard it.",
    "",
    "— The Payroost Team",
  ].join("\n");

  const html = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(subject)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f8fafc; color: #0f172a; margin: 0; padding: 24px; }
    .card { max-width: 560px; margin: 0 auto; background: #ffffff; border-radius: 16px; border: 1px solid #e2e8f0; padding: 36px; }
    .logo { font-size: 20px; font-weight: 800; color: #0f766e; text-transform: uppercase; letter-spacing: 0.1em; }
    h1 { font-size: 22px; font-weight: 700; color: #0f172a; margin-top: 20px; }
    p { font-size: 15px; line-height: 1.6; color: #334155; margin-bottom: 20px; }
    .btn { display: inline-block; background-color: #0f766e; color: #ffffff !important; text-decoration: none; font-weight: 600; font-size: 15px; padding: 12px 28px; border-radius: 10px; margin: 12px 0 24px; }
    .footer { font-size: 12px; color: #94a3b8; line-height: 1.5; margin-top: 28px; border-top: 1px solid #f1f5f9; padding-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">Payroost</div>
    <h1>Access your client portal</h1>
    <p>Hello <strong>${safeClientName}</strong>,</p>
    <p>You have been invited to access the client portal for <strong>${safeTitle}</strong> on Payroost. Here you can review agreements, track project milestones, and authorize payments securely.</p>
    <div style="text-align: center;">
      <a href="${safePortalUrl}" class="btn">Access Client Portal</a>
    </div>
    <p style="font-size: 13px; color: #64748b;">This link will expire in ${expiresInDays} days. If the button above does not work, copy and paste this link into your browser:</p>
    <p style="font-size: 12px; word-break: break-all; color: #0f766e;">${safePortalUrl}</p>
    <div class="footer">
      Payroost — Verified freelance agreements, milestone tracking, and payment coordination.<br>
      If you did not anticipate this email, you may safely disregard this message.
    </div>
  </div>
</body>
</html>
  `.trim();

  return { subject, html, text };
}

