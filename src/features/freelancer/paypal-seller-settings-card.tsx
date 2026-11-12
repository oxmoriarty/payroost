"use client";

import { useEffect, useState, useCallback } from "react";
import { useSearchParams } from "next/navigation";
import {
  CheckCircle2,
  AlertCircle,
  AlertTriangle,
  Loader2,
  ExternalLink,
  ShieldCheck,
  RefreshCw,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export interface SellerConnectionStatus {
  isConnected: boolean;
  onboardingStatus: "NOT_STARTED" | "INITIATED" | "COMPLETED" | "REVOKED" | "FAILED";
  paymentsReceivable: boolean;
  primaryEmailConfirmed: boolean;
  sellerMerchantIdMasked: string | null;
  sellerEmail: string | null;
  connectedAt: string | null;
}

export function PayPalSellerSettingsCard() {
  const searchParams = useSearchParams();
  const callbackStatus = searchParams.get("paypal_status");
  const callbackReason = searchParams.get("reason");

  const [statusData, setStatusData] = useState<SellerConnectionStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [isInitiating, setIsInitiating] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const res = await fetch("/api/app/freelancer/paypal/status", {
        headers: { "Cache-Control": "no-store" },
      });
      if (res.ok) {
        const data = (await res.json()) as SellerConnectionStatus;
        setStatusData(data);
      } else {
        setErrorMessage("Failed to load PayPal connection status.");
      }
    } catch {
      setErrorMessage("Network error while checking connection status.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;

    async function load() {
      try {
        const res = await fetch("/api/app/freelancer/paypal/status", {
          headers: { "Cache-Control": "no-store" },
        });
        if (!active) return;
        if (res.ok) {
          const data = (await res.json()) as SellerConnectionStatus;
          if (active) {
            setStatusData(data);
          }
        } else {
          if (active) {
            setErrorMessage("Failed to load PayPal connection status.");
          }
        }
      } catch {
        if (active) {
          setErrorMessage("Network error while checking connection status.");
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void load();

    return () => {
      active = false;
    };
  }, []);

  const handleConnectPayPal = async () => {
    try {
      setIsInitiating(true);
      setErrorMessage(null);
      const res = await fetch("/api/app/freelancer/paypal/onboard", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
        },
      });

      const data = (await res.json()) as {
        success?: boolean;
        actionUrl?: string;
        alreadyConnected?: boolean;
        error?: string;
        message?: string;
        details?: string;
      };

      if (!res.ok || !data.success || !data.actionUrl) {
        if (data.alreadyConnected) {
          await refreshStatus();
          return;
        }
        setErrorMessage(data.details || data.message || data.error || "Failed to start PayPal onboarding.");
        setIsInitiating(false);
        return;
      }

      // Redirect browser to PayPal Sandbox Partner Referrals action_url
      window.location.href = data.actionUrl;
    } catch {
      setErrorMessage("Network error while contacting PayPal onboarding service.");
      setIsInitiating(false);
    }
  };

  return (
    <Card className="mt-8 max-w-2xl p-6" data-testid="paypal-seller-settings-card">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="font-display text-xl text-ink-950">PayPal Seller Account</h2>
            <Badge tone="info" className="text-[11px] uppercase tracking-wider font-semibold">
              Sandbox
            </Badge>
          </div>
          <p className="mt-1 text-sm text-ink-600">
            Model 1 Platform Marketplace: Clients pay you directly for completed milestones. PayRoost never holds your funds.
          </p>
        </div>

        {statusData && (
          <div>
            {statusData.isConnected ? (
              <Badge tone="success" className="gap-1.5 px-3 py-1">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected & Ready
              </Badge>
            ) : statusData.onboardingStatus === "INITIATED" ? (
              <Badge tone="warning" className="gap-1.5 px-3 py-1">
                <RefreshCw className="h-3.5 w-3.5 animate-spin" />
                Pending Verification
              </Badge>
            ) : statusData.onboardingStatus === "NOT_STARTED" ? (
              <Badge tone="neutral" className="px-3 py-1">
                Not Connected
              </Badge>
            ) : (
              <Badge tone="warning" className="gap-1.5 px-3 py-1">
                <AlertTriangle className="h-3.5 w-3.5" />
                Action Required
              </Badge>
            )}
          </div>
        )}
      </div>

      {/* Callback Status Messages */}
      {(callbackStatus === "connected" || callbackStatus === "already_connected") && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-emerald-50 p-4 text-sm text-emerald-900 ring-1 ring-emerald-200">
          <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" />
          <div>
            <p className="font-semibold">
              {callbackStatus === "already_connected"
                ? "PayPal Seller Account Already Connected"
                : "PayPal Seller Account Connected Successfully"}
            </p>
            <p className="mt-0.5 text-xs text-emerald-700">
              Your PayPal Sandbox seller account has been verified. You can now accept direct milestone payments from clients.
            </p>
          </div>
        </div>
      )}

      {callbackStatus === "processing" && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-blue-50 p-4 text-sm text-blue-900 ring-1 ring-blue-200">
          <RefreshCw className="h-5 w-5 shrink-0 animate-spin text-blue-600" />
          <div>
            <p className="font-semibold">Verification In Flight</p>
            <p className="mt-0.5 text-xs text-blue-700">
              Your seller connection is currently being verified by PayPal. Please refresh in a moment.
            </p>
          </div>
        </div>
      )}

      {callbackStatus === "incomplete_onboarding" && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">PayPal Onboarding Incomplete</p>
            <p className="mt-0.5 text-xs text-amber-700">
              PayPal indicates that your seller account is not yet ready to receive payments ({callbackReason || "EMAIL_OR_BUSINESS_UNCONFIRMED"}). Please complete required verification in your PayPal Sandbox dashboard and retry.
            </p>
          </div>
        </div>
      )}

      {callbackStatus === "consent_declined" && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-amber-50 p-4 text-sm text-amber-900 ring-1 ring-amber-200">
          <AlertCircle className="h-5 w-5 shrink-0 text-amber-600" />
          <div>
            <p className="font-semibold">Consent Declined</p>
            <p className="mt-0.5 text-xs text-amber-700">
              Permissions were not granted on PayPal. PayRoost cannot route milestone payments to your account without third-party integration consent.
            </p>
          </div>
        </div>
      )}

      {(callbackStatus === "verification_failed" ||
        callbackStatus === "config_error" ||
        callbackStatus === "missing_merchant_id" ||
        callbackStatus === "invalid_state") && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-200">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
          <div>
            <p className="font-semibold">Connection Failed</p>
            <p className="mt-0.5 text-xs text-red-700">
              {callbackStatus === "config_error"
                ? "PayPal partner configuration is missing or invalid. Please contact platform administrators."
                : callbackStatus === "missing_merchant_id"
                ? "PayPal did not return a valid seller merchant identifier."
                : callbackStatus === "invalid_state"
                ? "The onboarding callback session was expired, invalid, or mismatched."
                : `Verification with PayPal failed (${callbackReason || "PROVIDER_ERROR"}). Please try connecting again.`}
            </p>
          </div>
        </div>
      )}

      {errorMessage && (
        <div className="mt-4 flex items-start gap-3 rounded-xl bg-red-50 p-4 text-sm text-red-900 ring-1 ring-red-200">
          <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
          <div>
            <p className="font-semibold">Connection Error</p>
            <p className="mt-0.5 text-xs text-red-700">{errorMessage}</p>
          </div>
        </div>
      )}

      {/* Body States */}
      <div className="mt-6 border-t border-ink-100 pt-5">
        {loading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-ink-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading seller connection details...
          </div>
        ) : statusData?.isConnected ? (
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 text-sm">
              <div className="rounded-xl border border-ink-100 bg-ink-50/50 p-3">
                <span className="text-xs font-medium text-ink-500">Merchant Account ID</span>
                <p className="mt-0.5 break-all font-mono font-semibold text-ink-900">
                  {statusData.sellerMerchantIdMasked ?? "Verified"}
                </p>
              </div>
              <div className="rounded-xl border border-ink-100 bg-ink-50/50 p-3">
                <span className="text-xs font-medium text-ink-500">Payments Receivable</span>
                <p className="mt-0.5 font-semibold text-emerald-700">
                  Enabled (Direct Payee)
                </p>
              </div>
            </div>

            {statusData.sellerEmail && (
              <p className="break-all text-xs text-ink-500">
                Connected Sandbox Account Email: <span className="font-mono text-ink-700">{statusData.sellerEmail}</span>
              </p>
            )}

            <div className="flex items-start gap-2 text-xs text-ink-500 sm:items-center">
              <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-teal-600 sm:mt-0" />
              <span>Payments route directly to your Sandbox seller balance upon client milestone approval.</span>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm text-ink-700">
              To activate milestone payouts, link your PayPal Sandbox business account. When your clients pay for a milestone, funds settle directly to your seller balance.
            </p>

            <div className="rounded-xl border border-ink-200/80 bg-ink-50/40 p-4 text-xs text-ink-600">
              <p className="font-semibold text-ink-800">Hackathon Sandbox Testing Tip:</p>
              <p className="mt-1">
                You can log into an existing PayPal Sandbox Business Account, or create a test account via the PayPal Developer Dashboard (`Testing Tools &gt; Sandbox Accounts`).
              </p>
            </div>

            <div className="pt-2">
              <Button
                variant="primary"
                onClick={handleConnectPayPal}
                disabled={isInitiating}
                className="w-full gap-2 sm:w-auto"
              >
                {isInitiating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Connecting to PayPal...
                  </>
                ) : (
                  <>
                    <ExternalLink className="h-4 w-4" />
                    Connect PayPal Sandbox Seller Account
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Card>
  );
}
