"use client";

import { useState } from "react";
import Link from "next/link";
import { CheckCircle2, AlertTriangle, ArrowRight, MailCheck, Loader2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

interface VerifyEmailClientProps {
  token?: string;
}

interface VerifiedData {
  projectId: string;
  clientEmail: string;
  projectTitle: string;
}

export function VerifyEmailClient({ token }: VerifyEmailClientProps) {
  const [status, setStatus] = useState<"idle" | "submitting" | "success" | "error">(
    !token || token.trim().length < 10 ? "error" : "idle"
  );
  const [verifiedData, setVerifiedData] = useState<VerifiedData | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(
    !token || token.trim().length < 10
      ? "This verification link is missing or malformed. Please verify the URL or ask your freelancer to resend the verification email."
      : null
  );

  async function handleConfirm() {
    if (!token) return;
    setStatus("submitting");
    setErrorMessage(null);

    try {
      const response = await fetch("/api/public/verify-client-email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token: token.trim() }),
      });

      const result = await response.json().catch(() => null);

      if (!response.ok || !result?.success || !result?.data) {
        setStatus("error");
        setErrorMessage(
          result?.error?.message ||
            "This verification link has already been used or has expired. If your email is not yet verified, please ask your freelancer to resend the verification email."
        );
        return;
      }

      setVerifiedData(result.data as VerifiedData);
      setStatus("success");
    } catch {
      setStatus("error");
      setErrorMessage("Network connection error. Please try again or refresh the page.");
    }
  }

  // Error state (invalid token or expired/already used)
  if (status === "error") {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <AlertTriangle className="h-7 w-7" />
          </div>
          <h1 className="mt-5 font-display text-2xl text-ink-950">Verification link invalid or expired</h1>
          <p className="mt-3 text-sm text-ink-700 leading-relaxed">
            {errorMessage ||
              "This verification link has already been used or has expired. If your email is not yet verified, please ask your freelancer to resend the verification email from their project workspace."}
          </p>
          <div className="mt-6">
            <Link href="/">
              <Button variant="secondary" className="w-full">
                Return to Payroost
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  // Success state (explicitly confirmed by client via POST)
  if (status === "success" && verifiedData) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
        <Card className="max-w-md w-full p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-teal-100 text-teal-700">
            <CheckCircle2 className="h-7 w-7" />
          </div>
          <p className="mt-5 text-xs font-bold uppercase tracking-[0.14em] text-teal-700">Identity confirmed</p>
          <h1 className="mt-1 font-display text-2xl text-ink-950">Email verified successfully</h1>
          <p className="mt-3 text-sm text-ink-700 leading-relaxed">
            Thank you for confirming your email address (<strong>{verifiedData.clientEmail}</strong>) for{" "}
            <strong>{verifiedData.projectTitle}</strong>.
          </p>
          <div className="mt-5 rounded-xl border border-teal-100 bg-teal-50/60 p-4 text-xs text-teal-900 text-left">
            <p className="font-semibold">What happens next?</p>
            <p className="mt-1 leading-relaxed text-teal-800">
              Your freelancer can now finalize and submit the project agreement. You will receive a secure review link
              to inspect deliverables, milestones, and payment terms.
            </p>
          </div>
          <div className="mt-6">
            <Link href="/">
              <Button className="w-full">
                Done <ArrowRight className="ml-2 h-4 w-4" />
              </Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  // Initial prompt: requires explicit human confirmation (GET prefetch scanners cannot trigger this)
  return (
    <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4">
      <Card className="max-w-md w-full p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-teal-50 text-teal-600 border border-teal-100">
          <MailCheck className="h-7 w-7" />
        </div>
        <p className="mt-5 text-xs font-bold uppercase tracking-[0.14em] text-teal-700">Client verification</p>
        <h1 className="mt-1 font-display text-2xl text-ink-950">Confirm your email address</h1>
        <p className="mt-3 text-sm text-ink-700 leading-relaxed">
          Please confirm that you own this email address to activate your reviewer access for the project agreement.
        </p>
        <div className="mt-6 space-y-3">
          <Button
            onClick={handleConfirm}
            disabled={status === "submitting"}
            className="w-full"
          >
            {status === "submitting" ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Verifying...
              </>
            ) : (
              "Confirm Email Verification"
            )}
          </Button>
          <Link href="/" className="block">
            <Button variant="ghost" className="w-full text-xs">
              Cancel
            </Button>
          </Link>
        </div>
      </Card>
    </div>
  );
}
