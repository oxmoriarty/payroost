"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { KeyRound, ShieldAlert, Loader2, ArrowRight, CheckCircle2, Lock } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ClientPortalEntryViewProps {
  token: string;
  projectTitle: string;
  expiresAt: string;
  onAuthenticated?: (csrfToken: string) => void;
}

export function ClientPortalEntryView({
  token,
  projectTitle,
  expiresAt,
  onAuthenticated,
}: ClientPortalEntryViewProps) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "requesting-otp" | "otp-input" | "verifying">("idle");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [maskedEmail, setMaskedEmail] = useState<string>("");
  const [otpCode, setOtpCode] = useState("");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [remainingAttempts, setRemainingAttempts] = useState<number | null>(null);

  async function handleRequestOtp() {
    setErrorMsg(null);
    setStep("requesting-otp");

    try {
      const res = await fetch(`/api/public/portal/${encodeURIComponent(token)}/otp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });

      const data = (await res.json()) as {
        success?: boolean;
        maskedEmail?: string;
        challengeId?: string;
        error?: string;
        remainingAttempts?: number;
      };

      if (!res.ok || !data.success || !data.challengeId) {
        if (res.status === 429) {
          setErrorMsg("Too many requests. Please wait a few minutes before trying again.");
        } else {
          setErrorMsg(data.error || "Unable to send verification code. Please try again.");
        }
        setStep("idle");
        return;
      }

      setChallengeId(data.challengeId);
      setMaskedEmail(data.maskedEmail || "your email");
      setStep("otp-input");
    } catch {
      setErrorMsg("Network error connecting to verification service. Please try again.");
      setStep("idle");
    }
  }

  async function handleVerifyOtp(e: React.FormEvent) {
    e.preventDefault();
    if (!challengeId || otpCode.trim().length !== 6) {
      setErrorMsg("Please enter the 6-digit verification code.");
      return;
    }

    setErrorMsg(null);
    setStep("verifying");

    try {
      const res = await fetch(`/api/public/portal/${encodeURIComponent(token)}/session`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          challengeId,
          otp: otpCode.trim(),
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        csrfToken?: string;
        error?: string;
        remainingAttempts?: number;
      };

      if (!res.ok || !data.success) {
        if (data.error === "INVALID_OTP") {
          const attempts = data.remainingAttempts ?? 0;
          setRemainingAttempts(attempts);
          setErrorMsg(`Invalid verification code. ${attempts} attempt${attempts === 1 ? "" : "s"} remaining.`);
        } else if (data.error === "OTP_EXHAUSTED") {
          setErrorMsg("Maximum verification attempts exceeded. Please request a new code.");
          setChallengeId(null);
          setStep("idle");
        } else if (data.error === "OTP_EXPIRED") {
          setErrorMsg("The verification code has expired. Please request a fresh code.");
          setChallengeId(null);
          setStep("idle");
        } else if (res.status === 429) {
          setErrorMsg("Rate limit exceeded. Please wait a few minutes.");
        } else {
          setErrorMsg(data.error || "Verification failed. Please try again.");
        }
        setStep("otp-input");
        return;
      }

      // Session cookie is set HttpOnly by backend.
      if (onAuthenticated && data.csrfToken) {
        onAuthenticated(data.csrfToken);
      }
      router.refresh();
    } catch {
      setErrorMsg("Network error verifying code. Please check your connection.");
      setStep("otp-input");
    }
  }

  const formattedExpiry = new Date(expiresAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="flex min-h-[80vh] items-center justify-center p-4">
      <Card className="w-full max-w-lg p-8 sm:p-10">
        <div className="mb-6 flex items-center justify-between border-b border-ink-100 pb-5">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-teal-50 text-teal-700">
              <Lock className="h-5 w-5" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-teal-700">Client Portal</p>
              <h2 className="text-sm font-medium text-ink-600">Secure Access</h2>
            </div>
          </div>
          <Badge tone="info">Invitation active until {formattedExpiry}</Badge>
        </div>

        <div className="text-center">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink-950 sm:text-3xl">
            {projectTitle}
          </h1>
          <p className="mt-2 text-sm text-ink-600">
            Access your project milestones, review deliverables, and approve secure milestone payments.
          </p>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="mt-6 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
          >
            <ShieldAlert className="h-5 w-5 shrink-0 text-red-600" />
            <div>
              <p className="font-semibold">Verification Alert</p>
              <p className="mt-0.5">{errorMsg}</p>
            </div>
          </div>
        )}

        {step === "idle" || step === "requesting-otp" ? (
          <div className="mt-8 space-y-4">
            <div className="rounded-xl border border-ink-100 bg-slate-50 p-4 text-xs text-ink-600">
              <div className="flex items-center gap-2 font-semibold text-ink-800">
                <CheckCircle2 className="h-4 w-4 text-teal-600" />
                <span>Protected Identity Verification</span>
              </div>
              <p className="mt-1">
                To protect financial information, a one-time 6-digit confirmation code will be dispatched to your verified client email.
              </p>
            </div>

            <Button
              className="w-full text-base font-semibold"
              onClick={handleRequestOtp}
              disabled={step === "requesting-otp"}
            >
              {step === "requesting-otp" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Sending confirmation code...
                </>
              ) : (
                <>
                  Send Verification Code
                  <ArrowRight className="ml-2 h-4 w-4" />
                </>
              )}
            </Button>
          </div>
        ) : (
          <form onSubmit={handleVerifyOtp} className="mt-8 space-y-5">
            <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-4 text-center">
              <KeyRound className="mx-auto h-6 w-6 text-teal-700" />
              <p className="mt-2 text-sm font-semibold text-teal-950">
                Verification code dispatched
              </p>
              <p className="mt-0.5 text-xs text-teal-800">
                We sent a 6-digit code to <span className="font-bold">{maskedEmail}</span>. The code expires in 15 minutes.
              </p>
            </div>

            <div>
              <label
                htmlFor="otp-input-field"
                className="block text-xs font-semibold uppercase tracking-wider text-ink-700"
              >
                6-Digit Confirmation Code
              </label>
              <input
                id="otp-input-field"
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                value={otpCode}
                onChange={(e) => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                placeholder="000000"
                autoComplete="one-time-code"
                autoFocus
                disabled={step === "verifying"}
                className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-4 py-3 text-center font-mono text-xl font-bold tracking-[0.25em] text-ink-950 shadow-sm focus:border-teal-600 focus:outline-none focus:ring-2 focus:ring-teal-600/20 disabled:bg-slate-100 sm:text-2xl sm:tracking-[0.5em]"
              />
              {remainingAttempts !== null && remainingAttempts > 0 && (
                <p className="mt-1.5 text-xs text-ink-500 text-center">
                  {remainingAttempts} attempt{remainingAttempts === 1 ? "" : "s"} remaining before code is revoked.
                </p>
              )}
            </div>

            <Button
              type="submit"
              className="w-full text-base font-semibold"
              disabled={step === "verifying" || otpCode.length !== 6}
            >
              {step === "verifying" ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Verifying Code...
                </>
              ) : (
                "Verify & Enter Portal"
              )}
            </Button>

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setStep("idle");
                  setOtpCode("");
                  setErrorMsg(null);
                }}
                className="text-xs font-semibold text-teal-700 hover:text-teal-800 hover:underline"
              >
                Did not receive the code? Send again
              </button>
            </div>
          </form>
        )}
      </Card>
    </div>
  );
}
