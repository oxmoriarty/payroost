"use client";

import { useState } from "react";
import { Mail, Loader2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function ResendVerificationButton({ projectId }: { projectId: string }) {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [isSuccess, setIsSuccess] = useState(false);

  async function handleResend() {
    setLoading(true);
    setStatus(null);
    try {
      const res = await fetch(`/api/projects/${projectId}/client-verification`, {
        method: "POST",
      });
      const data = (await res.json()) as { success?: boolean; error?: string; message?: string; alreadyVerified?: boolean };
      if (!res.ok) {
        if (res.status === 429) {
          setStatus("Too many requests. Please wait a few minutes before requesting another verification email.");
        } else {
          setStatus(data.error ?? "Failed to resend verification email.");
        }
        setIsSuccess(false);
      } else if (data.alreadyVerified) {
        setStatus("Client email is already verified.");
        setIsSuccess(true);
      } else {
        setStatus("Verification email sent successfully!");
        setIsSuccess(true);
      }
    } catch {
      setStatus("Unable to send verification email. Please check your network connection.");
      setIsSuccess(false);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col sm:flex-row sm:items-center gap-3">
      <Button
        type="button"
        variant="secondary"
        className="min-h-9 px-3 text-xs"
        disabled={loading}
        onClick={handleResend}
      >
        {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Mail className="mr-2 h-4 w-4" />}
        Resend verification email
      </Button>
      {status && (
        <span
          className={`text-xs flex items-center gap-1.5 ${
            isSuccess ? "text-teal-700 font-medium" : "text-amber-800"
          }`}
        >
          {isSuccess && <CheckCircle2 className="h-3.5 w-3.5" />}
          {status}
        </span>
      )}
    </div>
  );
}
