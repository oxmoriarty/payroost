"use client";

import { useState } from "react";
import { CheckCircle2, AlertCircle, ShieldAlert, KeyRound, Loader2, ArrowRight } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AgreementDocumentView,
  type AgreementContentLike,
} from "@/features/agreements/agreement-document-view";

interface PublicReviewData {
  review_link_id: string;
  project_title: string;
  client_name: string;
  freelancer_name: string;
  content: AgreementContentLike;
  version_number: number;
  sent_at: string;
  expires_at: string;
}

export function PublicReviewView({
  token,
  reviewData,
}: {
  token: string;
  reviewData: PublicReviewData;
}) {
  const [decisionStep, setDecisionStep] = useState<"idle" | "requesting-otp" | "otp-prompt" | "submitting" | "completed">("idle");
  const [selectedAction, setSelectedAction] = useState<"APPROVE" | "REQUEST_CHANGES" | null>(null);
  const [changeNote, setChangeNote] = useState("");
  const [otpCode, setOtpCode] = useState("");
  const [maskedEmail, setMaskedEmail] = useState<string>("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [finalStatus, setFinalStatus] = useState<string | null>(null);

  const { content } = reviewData;

  async function startDecision(action: "APPROVE" | "REQUEST_CHANGES") {
    if (action === "REQUEST_CHANGES" && changeNote.trim().length < 3) {
      setErrorMsg("Please provide a brief note explaining the requested changes (at least 3 characters).");
      return;
    }
    setErrorMsg(null);
    setSelectedAction(action);
    setDecisionStep("requesting-otp");

    try {
      const res = await fetch(`/api/public/review/${token}/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = (await res.json()) as { success?: boolean; maskedEmail?: string; error?: string };

      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? "Unable to request confirmation code. Please try again.");
        setDecisionStep("idle");
        return;
      }

      setMaskedEmail(data.maskedEmail ?? "your verified email");
      setDecisionStep("otp-prompt");
    } catch {
      setErrorMsg("Network error requesting verification code.");
      setDecisionStep("idle");
    }
  }

  async function submitDecisionWithOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedAction || otpCode.trim().length !== 6) {
      setErrorMsg("Please enter the 6-digit confirmation code.");
      return;
    }

    setErrorMsg(null);
    setDecisionStep("submitting");

    try {
      const res = await fetch(`/api/public/review/${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: selectedAction,
          note: changeNote,
          otpCode: otpCode.trim(),
        }),
      });

      const data = (await res.json()) as { status?: string; error?: string };
      if (!res.ok) {
        setErrorMsg(data.error ?? "Failed to submit decision. Please verify your OTP code.");
        setDecisionStep("otp-prompt");
        return;
      }

      setFinalStatus(data.status ?? selectedAction);
      setDecisionStep("completed");
    } catch {
      setErrorMsg("Network error submitting decision.");
      setDecisionStep("otp-prompt");
    }
  }

  if (decisionStep === "completed") {
    const isApproved = finalStatus === "APPROVED";
    return (
      <div className="mx-auto max-w-2xl py-12 px-4">
        <Card className="p-8 text-center sm:p-12">
          <div className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${isApproved ? "bg-teal-100 text-teal-700" : "bg-amber-100 text-amber-700"}`}>
            {isApproved ? <CheckCircle2 className="h-9 w-9" /> : <AlertCircle className="h-9 w-9" />}
          </div>
          <h1 className="mt-6 font-display text-3xl text-ink-950">
            {isApproved ? "Agreement Approved" : "Changes Requested"}
          </h1>
          <p className="mt-3 text-ink-700 leading-relaxed">
            {isApproved
              ? "You have successfully approved this agreement. The freelancer has been notified and the project workspace is now active."
              : "Your requested changes have been recorded and sent to the freelancer to revise."}
          </p>
          <div className="mt-6 rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs text-ink-700 text-left">
            <p><strong>Project:</strong> {reviewData.project_title}</p>
            <p className="mt-1"><strong>Version:</strong> {reviewData.version_number}</p>
            <p className="mt-1"><strong>Decision recorded at:</strong> {new Date().toLocaleString()}</p>
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl py-10 px-4 space-y-8">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4 border-b border-ink-100 pb-6">
        <div>
          <p className="text-xs font-bold uppercase tracking-[0.14em] text-teal-700">Agreement review</p>
          <h1 className="mt-1 font-display text-3xl sm:text-4xl text-ink-950">{reviewData.project_title}</h1>
          <p className="mt-2 text-sm text-ink-700">
            Prepared by <strong>{reviewData.freelancer_name}</strong> for <strong>{reviewData.client_name}</strong>
          </p>
        </div>
        <div className="text-right">
          <Badge tone="info">Version {reviewData.version_number}</Badge>
          <p className="mt-1 text-xs text-ink-500">Expires {new Date(reviewData.expires_at).toLocaleDateString()}</p>
        </div>
      </div>

      {errorMsg && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900 flex items-start gap-3">
          <ShieldAlert className="h-5 w-5 text-red-700 shrink-0 mt-0.5" />
          <p>{errorMsg}</p>
        </div>
      )}

      {/* Scope, Deliverables, Acceptance Criteria, and Terms */}
      <Card className="p-6 sm:p-8">
        <AgreementDocumentView content={content} />
      </Card>

      {/* Decision Section with OTP Challenge Flow */}
      <Card className="p-6 sm:p-8 bg-slate-50/70 border-2 border-slate-200">
        <h2 className="font-display text-2xl text-ink-950">Review Decision</h2>
        <p className="mt-2 text-sm text-ink-700">
          Decisions are legally attributed to your verified email address and require confirmation with a single-use security code.
        </p>

        {decisionStep === "otp-prompt" ? (
          <form onSubmit={submitDecisionWithOtp} className="mt-6 rounded-2xl border border-teal-200 bg-white p-6 shadow-sm space-y-4">
            <div className="flex items-center gap-3 text-teal-800">
              <KeyRound className="h-6 w-6 text-teal-700 shrink-0" />
              <div>
                <p className="font-bold text-sm text-ink-950">Security Confirmation Code Required</p>
                <p className="text-xs text-ink-600">
                  We dispatched a 6-digit verification code to <strong>{maskedEmail}</strong> to confirm your decision to {selectedAction === "APPROVE" ? "approve" : "request changes"}.
                </p>
              </div>
            </div>

            <div className="pt-2">
              <label className="block text-xs font-bold uppercase tracking-wider text-ink-700 mb-2">
                Enter 6-digit Code
              </label>
              <input
                type="text"
                pattern="[0-9]{6}"
                maxLength={6}
                required
                autoFocus
                placeholder="000000"
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value)}
                className="w-full text-center text-3xl font-mono tracking-[0.3em] font-bold p-3 rounded-xl border border-ink-300 focus:border-teal-600 focus:ring-2 focus:ring-teal-600/20 outline-none"
              />
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 pt-3">
              <button
                type="button"
                onClick={() => setDecisionStep("idle")}
                className="text-xs font-semibold text-ink-600 hover:text-ink-900"
              >
                Cancel
              </button>
              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-9 px-3 text-xs"
                  onClick={() => selectedAction && startDecision(selectedAction)}
                >
                  Resend code
                </Button>
                <Button type="submit" disabled={otpCode.trim().length !== 6}>
                  Confirm Decision <ArrowRight className="ml-1.5 h-4 w-4" />
                </Button>
              </div>
            </div>
          </form>
        ) : (
          <div className="mt-6 space-y-5">
            <div>
              <label className="block text-sm font-semibold text-ink-800 mb-1.5">
                Feedback or Requested Changes (Optional for approval, required for change request)
              </label>
              <textarea
                className="w-full min-h-24 rounded-xl border border-ink-200 bg-white p-3 text-sm outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                placeholder="If you need adjustments to dates, deliverables, or payment milestones, describe them here."
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
              />
            </div>

            <div className="flex flex-wrap gap-3 pt-2">
              <Button
                onClick={() => startDecision("APPROVE")}
                disabled={decisionStep === "requesting-otp"}
                className="bg-teal-700 hover:bg-teal-600"
              >
                {decisionStep === "requesting-otp" && selectedAction === "APPROVE" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-2 h-4 w-4" />
                )}
                Approve Agreement
              </Button>
              <Button
                onClick={() => startDecision("REQUEST_CHANGES")}
                disabled={decisionStep === "requesting-otp"}
                variant="secondary"
              >
                {decisionStep === "requesting-otp" && selectedAction === "REQUEST_CHANGES" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <AlertCircle className="mr-2 h-4 w-4" />
                )}
                Request Changes
              </Button>
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}
