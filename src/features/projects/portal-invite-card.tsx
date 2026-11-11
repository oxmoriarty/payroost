"use client";

import { useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, MailCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type PortalInviteCardProps = {
  projectId: string;
  isClientVerified: boolean;
  clientName: string;
  clientEmail: string;
  agreementApproved: boolean;
};

export function PortalInviteCard({
  projectId,
  isClientVerified,
  clientName,
  clientEmail,
  agreementApproved,
}: PortalInviteCardProps) {
  const [sending, setSending] = useState(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  async function sendPortalInvite() {
    setSending(true);
    setFeedback(null);

    try {
      const res = await fetch(`/api/projects/${projectId}/portal-link`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });

      const payload = (await res.json()) as {
        success?: boolean;
        expiresAt?: string;
        error?: string;
      };

      if (!res.ok || !payload.success) {
        if (payload.error === "CLIENT_EMAIL_NOT_VERIFIED") {
          setFeedback({
            type: "error",
            text: "Client email must be verified before issuing a workspace portal invitation.",
          });
        } else if (payload.error === "RATE_LIMITED") {
          setFeedback({
            type: "error",
            text: "Too many invite requests. Please wait a few minutes before sending another invitation.",
          });
        } else if (payload.error === "EMAIL_DELIVERY_FAILED") {
          setFeedback({
            type: "error",
            text: "The invitation email provider failed to deliver. Check email configuration and retry.",
          });
        } else {
          setFeedback({
            type: "error",
            text: payload.error || "Unable to send client portal invite.",
          });
        }
        return;
      }

      const expiryText = payload.expiresAt
        ? ` Valid until ${new Date(payload.expiresAt).toLocaleString()}.`
        : "";
      setFeedback({
        type: "success",
        text: `A fresh OTP-protected Client Portal invitation was emailed directly to ${clientEmail}.${expiryText} Previous unused portal links have been superseded.`,
      });
    } catch {
      setFeedback({
        type: "error",
        text: "Network error while sending the client portal invitation.",
      });
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="p-5 sm:p-6">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-display text-lg text-ink-950">Client Workspace Portal</h3>
            <Badge tone={agreementApproved ? "success" : "neutral"}>
              {agreementApproved ? "Ready for collaboration" : "Available after verification"}
            </Badge>
          </div>
          <p className="text-sm text-ink-700">
            Invite <strong>{clientName}</strong> ({clientEmail}) to their dedicated OTP-protected Client Portal to view agreed milestones, accept submitted deliverables, submit scope changes, and complete PayPal checkout.
          </p>
        </div>

        <Button
          className="shrink-0"
          disabled={!isClientVerified || sending}
          onClick={sendPortalInvite}
          type="button"
          variant={agreementApproved ? "primary" : "secondary"}
        >
          {sending ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Sending invite...
            </>
          ) : (
            <>
              <MailCheck className="mr-2 h-4 w-4" />
              Send client portal invite
            </>
          )}
        </Button>
      </div>

      {!isClientVerified && (
        <p className="mt-3 text-xs text-amber-800">
          Locked until the client confirms their email address above.
        </p>
      )}

      {feedback && (
        <div
          className={`mt-4 flex items-start gap-2 rounded-xl border p-3 text-xs leading-relaxed ${
            feedback.type === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-950"
              : "border-red-200 bg-red-50 text-red-950"
          }`}
          role="status"
        >
          {feedback.type === "success" ? (
            <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-700" />
          ) : (
            <ExternalLink className="mt-0.5 h-4 w-4 shrink-0 text-red-700" />
          )}
          <p>{feedback.text}</p>
        </div>
      )}
    </Card>
  );
}
