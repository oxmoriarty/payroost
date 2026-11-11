"use client";

import { useRef, useState, useCallback, useEffect } from "react";
import {
  ShieldCheck,
  CheckCircle2,
  AlertCircle,
  Loader2,
  RotateCcw,
  DollarSign,
  AlertTriangle,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import type { PortalMilestone } from "./types";

interface MilestoneCheckoutProps {
  token: string;
  milestone: PortalMilestone;
  csrfToken: string;
  onPaymentSuccess?: (captureId: string) => void;
  onCancel?: () => void;
}

type CheckoutStep =
  | "INIT"
  | "CREATING_INTENT"
  | "CREATING_ORDER"
  | "READY_FOR_PAYPAL"
  | "CAPTURING"
  | "COMPLETED"
  | "PENDING_RECONCILIATION"
  | "ERROR";

declare global {
  interface Window {
    paypal?: {
      Buttons: (config: {
        createOrder: () => Promise<string> | string;
        onApprove: (data: { orderID: string; payerID?: string }) => Promise<void>;
        onCancel?: (data: unknown) => void;
        onError?: (err: unknown) => void;
        style?: Record<string, unknown>;
      }) => {
        render: (container: HTMLElement | string) => Promise<void>;
        close?: () => Promise<void>;
      };
    };
  }
}

export function MilestoneCheckout({
  token,
  milestone,
  csrfToken,
  onPaymentSuccess,
  onCancel,
}: MilestoneCheckoutProps) {
  const initialStep: CheckoutStep =
    milestone.paymentStatus === "PAID"
      ? "COMPLETED"
      : milestone.paymentStatus === "PENDING_VERIFICATION"
        ? "PENDING_RECONCILIATION"
        : "INIT";

  const [step, setStep] = useState<CheckoutStep>(initialStep);
  const [paymentIntentId, setPaymentIntentId] = useState<string | null>(milestone.paymentIntentId ?? null);
  const [orderId, setOrderId] = useState<string | null>(milestone.providerOrderId ?? null);
  const [approvalUrl, setApprovalUrl] = useState<string | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(milestone.completedCaptureId ?? null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [reconciliationReason, setReconciliationReason] = useState<string | null>(null);
  const [isSdkLoading, setIsSdkLoading] = useState(false);
  const [sdkLoadError, setSdkLoadError] = useState(false);

  // Lifecycle & Concurrency Refs
  const isMountedRef = useRef(true);
  const isInitiatingRef = useRef(false);
  const isRenderingButtonsRef = useRef(false);
  const buttonsRenderedRef = useRef(false);
  const paypalButtonsInstanceRef = useRef<{
    close?: () => Promise<void>;
  } | null>(null);
  const isCapturingRef = useRef(false);
  const paypalContainerRef = useRef<HTMLDivElement>(null);

  // Component Mount Tracking & Cleanup
  useEffect(() => {
    isMountedRef.current = true;
    const container = paypalContainerRef.current;
    return () => {
      isMountedRef.current = false;
      if (paypalButtonsInstanceRef.current) {
        try {
          paypalButtonsInstanceRef.current.close?.();
        } catch {
          // ignore SDK close errors during unmount
        }
        paypalButtonsInstanceRef.current = null;
      }
      if (container) {
        container.innerHTML = "";
      }
    };
  }, []);

  // Load official PayPal JavaScript SDK
  const loadPayPalSdk = useCallback(async (): Promise<boolean> => {
    if (window.paypal) return true;

    if (isMountedRef.current) {
      setIsSdkLoading(true);
      setSdkLoadError(false);
    }

    const clientId = process.env.NEXT_PUBLIC_PAYPAL_CLIENT_ID || "sb";
    const scriptId = "paypal-sdk-script";

    return new Promise((resolve) => {
      const existingScript = document.getElementById(scriptId);
      if (existingScript) {
        if (window.paypal) {
          if (isMountedRef.current) setIsSdkLoading(false);
          resolve(true);
        } else {
          existingScript.addEventListener("load", () => {
            if (isMountedRef.current) setIsSdkLoading(false);
            resolve(true);
          });
          existingScript.addEventListener("error", () => {
            if (isMountedRef.current) {
              setIsSdkLoading(false);
              setSdkLoadError(true);
            }
            resolve(false);
          });
        }
        return;
      }

      const script = document.createElement("script");
      script.id = scriptId;
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=USD&intent=capture`;
      script.async = true;

      script.onload = () => {
        if (isMountedRef.current) setIsSdkLoading(false);
        resolve(true);
      };

      script.onerror = () => {
        if (isMountedRef.current) {
          setIsSdkLoading(false);
          setSdkLoadError(true);
        }
        resolve(false);
      };

      document.body.appendChild(script);
    });
  }, []);

  // Step A: Create or retrieve payment intent
  const initializePaymentIntent = useCallback(async (): Promise<string | null> => {
    if (isMountedRef.current) {
      setErrorMessage(null);
      setStep("CREATING_INTENT");
    }

    try {
      const res = await fetch(`/api/public/portal/${encodeURIComponent(token)}/payments/intents`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          milestoneId: milestone.id,
        }),
      });

      const data = (await res.json()) as {
        success?: boolean;
        paymentIntentId?: string;
        status?: string;
        error?: string;
        message?: string;
      };

      if (!isMountedRef.current) return null;

      if (!res.ok || !data.paymentIntentId) {
        if (data.error === "MILESTONE_ALREADY_COMPLETED") {
          setStep("COMPLETED");
          return null;
        }
        if (data.error === "RECONCILIATION_REQUIRED") {
          setStep("PENDING_RECONCILIATION");
          setReconciliationReason("Payment verification is already in progress.");
          return null;
        }
        if (res.status === 401) {
          setErrorMessage("Your session has expired. Please refresh the page to sign in again.");
        } else if (res.status === 403) {
          setErrorMessage("Security token verification failed. Please refresh your browser.");
        } else {
          setErrorMessage(data.error || "Unable to initialize payment intent. Please try again.");
        }
        setStep("ERROR");
        return null;
      }

      setPaymentIntentId(data.paymentIntentId);
      return data.paymentIntentId;
    } catch {
      if (isMountedRef.current) {
        setErrorMessage("Network error initializing payment intent. Please check your connection.");
        setStep("ERROR");
      }
      return null;
    }
  }, [csrfToken, milestone.id, token]);

  // Step B: Create or retrieve PayPal Order
  const initializePayPalOrder = useCallback(
    async (intentId: string): Promise<string | null> => {
      if (isMountedRef.current) {
        setErrorMessage(null);
        setStep("CREATING_ORDER");
      }

      try {
        const res = await fetch(`/api/public/portal/${encodeURIComponent(token)}/payments/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            paymentIntentId: intentId,
            milestoneId: milestone.id,
          }),
        });

        const data = (await res.json()) as {
          success?: boolean;
          orderId?: string;
          paymentIntentId?: string;
          status?: string;
          approvalUrl?: string | null;
          error?: string;
        };

        if (!isMountedRef.current) return null;

        if (!res.ok || !data.orderId) {
          if (data.error === "MILESTONE_ALREADY_COMPLETED") {
            setStep("COMPLETED");
            return null;
          }
          if (data.error === "RECONCILIATION_REQUIRED") {
            setStep("PENDING_RECONCILIATION");
            setReconciliationReason("Order creation was flagged for verification.");
            return null;
          }
          setErrorMessage(data.error || "Unable to create PayPal order. Please try again.");
          setStep("ERROR");
          return null;
        }

        setOrderId(data.orderId);
        if (data.approvalUrl) {
          setApprovalUrl(data.approvalUrl);
        }
        return data.orderId;
      } catch {
        if (isMountedRef.current) {
          setErrorMessage("Network error creating PayPal order. Please try again.");
          setStep("ERROR");
        }
        return null;
      }
    },
    [csrfToken, milestone.id, token]
  );

  // Step D: Capture Payment Server-Side upon buyer approval
  const capturePaymentServerSide = useCallback(
    async (approvedOrderId: string, currentIntentId: string) => {
      if (isCapturingRef.current) return;
      isCapturingRef.current = true;

      if (isMountedRef.current) {
        setStep("CAPTURING");
        setErrorMessage(null);
      }

      try {
        const res = await fetch(`/api/public/portal/${encodeURIComponent(token)}/payments/capture`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-csrf-token": csrfToken,
          },
          body: JSON.stringify({
            orderId: approvedOrderId,
            paymentIntentId: currentIntentId,
          }),
        });

        const data = (await res.json()) as {
          success?: boolean;
          status?: string;
          captureId?: string;
          error?: string;
          message?: string;
        };

        if (!res.ok) {
          if (res.status === 409 && data.error === "RECONCILIATION_REQUIRED") {
            if (isMountedRef.current) {
              setStep("PENDING_RECONCILIATION");
              setReconciliationReason("Your payment was received by PayPal and is undergoing server verification.");
            }
            return;
          }
          if (res.status === 409 && data.error === "CAPTURE_IN_PROGRESS") {
            if (isMountedRef.current) {
              setStep("CAPTURING");
            }
            return;
          }
          if (data.error === "PAYMENT_DECLINED") {
            if (isMountedRef.current) {
              setErrorMessage("Payment was declined by PayPal. Please choose another payment method.");
              setStep("ERROR");
            }
            return;
          }
          if (isMountedRef.current) {
            setErrorMessage(data.error || data.message || "Payment capture was not completed.");
            setStep("ERROR");
          }
          return;
        }

        if (data.status === "COMPLETED") {
          if (isMountedRef.current) {
            setCaptureId(data.captureId || null);
            setStep("COMPLETED");
          }
          if (onPaymentSuccess && data.captureId) {
            onPaymentSuccess(data.captureId);
          }
        } else if (data.status === "PENDING") {
          if (isMountedRef.current) {
            setStep("PENDING_RECONCILIATION");
            setReconciliationReason("Payment status is PENDING with PayPal. Funds will be verified shortly.");
          }
        } else {
          if (isMountedRef.current) {
            setStep("PENDING_RECONCILIATION");
          }
        }
      } catch {
        // Network timeout or drop during capture
        if (isMountedRef.current) {
          setStep("PENDING_RECONCILIATION");
          setReconciliationReason(
            "Connection was interrupted during capture. Do not pay again. Server is verifying payment."
          );
        }
      } finally {
        isCapturingRef.current = false;
      }
    },
    [csrfToken, onPaymentSuccess, token]
  );

  // Step C: Render PayPal Buttons
  const renderPayPalButtons = useCallback(
    async (activeOrderId: string, activeIntentId: string) => {
      if (!paypalContainerRef.current) return;
      if (buttonsRenderedRef.current || isRenderingButtonsRef.current) return;

      isRenderingButtonsRef.current = true;

      const sdkReady = await loadPayPalSdk();
      if (!isMountedRef.current) {
        isRenderingButtonsRef.current = false;
        return;
      }

      if (!sdkReady || !window.paypal) {
        isRenderingButtonsRef.current = false;
        if (isMountedRef.current) {
          setSdkLoadError(true);
          setStep("ERROR");
        }
        return;
      }

      if (paypalContainerRef.current) {
        paypalContainerRef.current.innerHTML = "";
      }

      try {
        const buttonsInstance = window.paypal.Buttons({
          createOrder: () => activeOrderId,
          onApprove: async (data: { orderID: string }) => {
            // Guard against stale callback capturing an obsolete or mismatched order
            if (data.orderID !== activeOrderId) {
              return;
            }
            await capturePaymentServerSide(data.orderID, activeIntentId);
          },
          onCancel: () => {
            if (isMountedRef.current) {
              setErrorMessage("Checkout was cancelled in PayPal. You can retry when ready.");
            }
          },
          onError: () => {
            if (isMountedRef.current) {
              setErrorMessage("An error occurred during the PayPal checkout process.");
            }
          },
          style: {
            layout: "vertical",
            color: "gold",
            shape: "rect",
            label: "paypal",
            height: 48,
          },
        });

        paypalButtonsInstanceRef.current = buttonsInstance;

        await buttonsInstance.render(paypalContainerRef.current);

        if (isMountedRef.current) {
          buttonsRenderedRef.current = true;
          setStep("READY_FOR_PAYPAL");
        }
      } catch {
        if (isMountedRef.current) {
          setErrorMessage("Unable to render PayPal payment buttons.");
          setStep("ERROR");
        }
      } finally {
        isRenderingButtonsRef.current = false;
      }
    },
    [capturePaymentServerSide, loadPayPalSdk]
  );

  // Start checkout flow sequence
  const startCheckout = useCallback(async () => {
    if (isInitiatingRef.current) return;
    isInitiatingRef.current = true;

    try {
      let activeIntentId = paymentIntentId;
      if (!activeIntentId) {
        activeIntentId = await initializePaymentIntent();
        if (!activeIntentId || !isMountedRef.current) return;
      }

      let activeOrderId = orderId;
      if (!activeOrderId) {
        activeOrderId = await initializePayPalOrder(activeIntentId);
        if (!activeOrderId || !isMountedRef.current) return;
      }

      await renderPayPalButtons(activeOrderId, activeIntentId);
    } finally {
      isInitiatingRef.current = false;
    }
  }, [initializePaymentIntent, initializePayPalOrder, orderId, paymentIntentId, renderPayPalButtons]);

  return (
    <Card className="overflow-hidden border border-ink-100 bg-white p-6 shadow-sm sm:p-8">
      {/* Header */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between border-b border-ink-100 pb-5">
        <div>
          <span className="text-xs font-semibold uppercase tracking-wider text-teal-700">Milestone Checkout</span>
          <h2 className="mt-1 font-display text-xl font-bold text-ink-950 sm:text-2xl">
            {milestone.title}
          </h2>
        </div>
        <div className="flex items-center gap-3">
          <Badge tone="info">PayPal Sandbox</Badge>
          <span className="font-display text-2xl font-extrabold text-ink-950">
            {formatMoney(milestone.amountMinor, milestone.currency)}
          </span>
        </div>
      </div>

      {/* Description & Deliverables */}
      <div className="mt-5 space-y-3">
        {milestone.description && (
          <p className="text-sm text-ink-700 leading-relaxed">{milestone.description}</p>
        )}

        {milestone.deliverables && milestone.deliverables.length > 0 && (
          <div className="rounded-xl bg-slate-50 p-4 border border-ink-100">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-ink-600">Included Deliverables</h4>
            <ul className="mt-2 space-y-1.5 text-xs text-ink-800">
              {milestone.deliverables.map((deliv, idx) => (
                <li key={idx} className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-teal-600 shrink-0" />
                  <span>{deliv}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Security Guarantee Banner */}
      <div className="mt-5 flex items-center gap-3 rounded-xl border border-teal-100 bg-teal-50/50 p-3.5 text-xs text-teal-900">
        <ShieldCheck className="h-5 w-5 text-teal-700 shrink-0" />
        <span>
          PayRoost ensures server-verified capture, lease fencing, and authoritative ledger immutability for this transaction.
        </span>
      </div>

      {/* Error Message */}
      {errorMessage && (
        <div
          role="alert"
          className="mt-5 flex items-start gap-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800"
        >
          <AlertCircle className="h-5 w-5 text-red-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="font-semibold">Checkout Alert</p>
            <p className="mt-0.5 text-xs text-red-700">{errorMessage}</p>
          </div>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-xs font-semibold text-red-600 hover:text-red-800"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* State A: COMPLETED */}
      {step === "COMPLETED" && (
        <div className="mt-6 rounded-2xl border border-emerald-200 bg-emerald-50/60 p-6 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
            <CheckCircle2 className="h-8 w-8" />
          </div>
          <h3 className="mt-3 font-display text-lg font-bold text-emerald-950">
            Payment Captured & Verified
          </h3>
          <p className="mt-1 text-sm text-emerald-800">
            The milestone payment of {formatMoney(milestone.amountMinor, milestone.currency)} has been completed on PayPal and verified on the ledger.
          </p>
          {captureId && (
            <p className="mt-2 text-xs font-mono text-emerald-700">
              Provider Capture ID: <span className="font-bold">{captureId}</span>
            </p>
          )}
          <div className="mt-5 flex justify-center gap-3">
            <Button
              variant="secondary"
              onClick={() => {
                if (onCancel) onCancel();
              }}
            >
              Done
            </Button>
          </div>
        </div>
      )}

      {/* State B: PENDING_RECONCILIATION */}
      {step === "PENDING_RECONCILIATION" && (
        <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50/70 p-6">
          <div className="flex items-start gap-3">
            <AlertTriangle className="h-6 w-6 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <h3 className="font-display text-base font-bold text-amber-950">
                Payment Verification Pending
              </h3>
              <p className="mt-1 text-sm text-amber-800 leading-relaxed">
                {reconciliationReason || "Your payment was submitted to PayPal and is undergoing server verification."}
              </p>
              <div className="mt-3 rounded-xl bg-amber-100/70 p-3 text-xs text-amber-900">
                <span className="font-bold">Important:</span> Do not attempt a second payment for this milestone. PayRoost will update the status automatically once provider confirmation completes.
              </div>
              <div className="mt-4 flex gap-3">
                <Button
                  variant="secondary"
                  className="text-xs"
                  onClick={() => window.location.reload()}
                >
                  <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
                  Check Status
                </Button>
                {onCancel && (
                  <Button variant="ghost" className="text-xs" onClick={onCancel}>
                    Close
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* State C: CAPTURING IN PROGRESS */}
      {step === "CAPTURING" && (
        <div className="mt-6 rounded-2xl border border-teal-200 bg-teal-50/50 p-8 text-center">
          <Loader2 className="mx-auto h-10 w-10 animate-spin text-teal-600" />
          <h3 className="mt-4 font-display text-lg font-bold text-teal-950">
            Verifying PayPal Capture...
          </h3>
          <p className="mt-1 text-sm text-teal-800">
            Authorizing payment with PayPal and validating milestone financial invariants. Please do not close this window.
          </p>
        </div>
      )}

      {/* State D: INITIAL STEP / SDK LOADING / BUTTON RENDERING */}
      {step !== "COMPLETED" && step !== "PENDING_RECONCILIATION" && step !== "CAPTURING" && (
        <div className="mt-6 space-y-4">
          {step === "INIT" && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="text-xs text-ink-500">
                Click below to begin secure checkout through PayPal Sandbox.
              </div>
              <div className="flex gap-2">
                {onCancel && (
                  <Button variant="ghost" onClick={onCancel} className="text-xs">
                    Cancel
                  </Button>
                )}
                <Button
                  onClick={startCheckout}
                  disabled={!milestone.isPayable}
                  className="w-full sm:w-auto"
                >
                  <DollarSign className="mr-1.5 h-4 w-4" />
                  Pay with PayPal ({formatMoney(milestone.amountMinor, milestone.currency)})
                </Button>
              </div>
            </div>
          )}

          {(step === "CREATING_INTENT" || step === "CREATING_ORDER") && (
            <div className="flex items-center justify-center gap-3 rounded-xl border border-ink-100 bg-slate-50 py-8">
              <Loader2 className="h-5 w-5 animate-spin text-teal-600" />
              <span className="text-sm font-semibold text-ink-800">
                {step === "CREATING_INTENT" ? "Initializing payment intent..." : "Creating PayPal order..."}
              </span>
            </div>
          )}

          {isSdkLoading && (
            <div className="flex items-center justify-center gap-3 rounded-xl border border-ink-100 bg-slate-50 py-6">
              <Loader2 className="h-5 w-5 animate-spin text-teal-600" />
              <span className="text-sm text-ink-700">Loading PayPal Checkout...</span>
            </div>
          )}

          {sdkLoadError && (
            <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-center">
              <p className="text-sm font-semibold text-red-800">Unable to load PayPal Checkout</p>
              <p className="mt-0.5 text-xs text-red-600">Please check your internet connection or ad blocker settings and retry.</p>
              <Button variant="secondary" className="mt-3 text-xs" onClick={startCheckout}>
                Retry Loading Checkout
              </Button>
            </div>
          )}

          {/* Container for PayPal Buttons */}
          <div
            id="paypal-button-container"
            ref={paypalContainerRef}
            className={`min-h-[48px] ${step === "READY_FOR_PAYPAL" ? "block" : "hidden"}`}
          />

          {step === "READY_FOR_PAYPAL" && approvalUrl && (
            <div className="pt-2 text-center">
              <a
                href={approvalUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center text-xs font-semibold text-teal-700 hover:text-teal-900 underline"
              >
                Or approve directly on PayPal Sandbox &rarr;
              </a>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
