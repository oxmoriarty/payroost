"use client";

import { useEffect, useState, useCallback } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Eye,
  FileSearch,
  History,
  Info,
  Loader2,
  Lock,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Webhook,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import type { PaymentOperationRow } from "@/features/payments/operations-data";
import {
  computeRecoveryActionMatrix,
  type RecoveryActionDescriptor,
  type RecoveryActionType,
} from "@/features/payments/recovery-actions";
import type { PaymentInvestigationDossier } from "@/features/payments/investigation-data";

export interface PaymentInvestigationModalProps {
  row: PaymentOperationRow | null;
  open: boolean;
  isOwner: boolean;
  initialView?: "inspect" | "recover";
  onClose: () => void;
  onRecovered: () => void;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return "—";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatMoney(cents: number, currency = "USD"): string {
  const num = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency || "USD",
    }).format(num);
  } catch {
    return `${currency || "USD"} ${num.toFixed(2)}`;
  }
}

export function getWebhookDisplayLabel(status: string | null | undefined): string {
  const normalized = (status || "").toUpperCase();
  switch (normalized) {
    case "PROCESSED":
      return "Processed";
    case "DUPLICATE":
      return "Duplicate";
    case "RETRY_SCHEDULED":
    case "RETRY":
      return "Retry scheduled";
    case "EXHAUSTED":
      return "Attempts exhausted";
    case "PROCESSING":
      return "Processing";
    case "VERIFIED":
      return "Verified";
    case "RECEIVED":
      return "Received";
    case "REQUIRES_RECONCILIATION":
      return "Requires reconciliation";
    case "FAILED":
      return "Failed";
    default:
      return "None";
  }
}

function pickInitialAction(row: PaymentOperationRow): RecoveryActionType {
  if (
    row.status === "RECONCILIATION_REQUIRED" &&
    !row.providerOrderId &&
    !row.idempotencyWindowExpired
  ) {
    return "RETRY_ORDER_CREATION";
  }
  if (row.webhookIsExhausted || row.webhookStatus === "REQUIRES_RECONCILIATION") {
    return "REPROCESS_WEBHOOK";
  }
  if (row.hasExpiredLease && row.status !== "RECONCILIATION_REQUIRED") {
    return "CLEAR_EXPIRED_LEASE";
  }
  if (row.status === "ORDER_CREATED" || row.status === "BUYER_APPROVED") {
    return "ESCALATE_MANUAL";
  }
  return "RECONCILE";
}

export function PaymentInvestigationModal(props: PaymentInvestigationModalProps) {
  if (!props.open || !props.row) return null;
  return (
    <PaymentInvestigationModalContent
      key={`${props.row.id}-${props.initialView ?? "inspect"}`}
      row={props.row}
      isOwner={props.isOwner}
      initialView={props.initialView}
      onClose={props.onClose}
      onRecovered={props.onRecovered}
    />
  );
}

function PaymentInvestigationModalContent({
  row,
  isOwner,
  initialView = "inspect",
  onClose,
  onRecovered,
}: {
  row: PaymentOperationRow;
  isOwner: boolean;
  initialView?: "inspect" | "recover";
  onClose: () => void;
  onRecovered: () => void;
}) {
  const [activeTab, setActiveTab] = useState<"overview" | "webhooks" | "timeline" | "recover">(
    () => (initialView === "recover" ? "recover" : "overview")
  );
  const [dossier, setDossier] = useState<PaymentInvestigationDossier | null>(null);
  const [loadingDossier, setLoadingDossier] = useState(true);
  const [dossierError, setDossierError] = useState<string | null>(null);

  const [selectedAction, setSelectedAction] = useState<RecoveryActionType>(() =>
    pickInitialAction(row)
  );
  const [recoveryNotes, setRecoveryNotes] = useState("");
  const [selectedWebhookId, setSelectedWebhookId] = useState<string | null>(
    () => row.webhookEventId || null
  );
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: "success" | "error"; message: string } | null>(
    null
  );

  const applyResolvedDossier = useCallback((loaded: PaymentInvestigationDossier) => {
    setDossier(loaded);
    setSelectedWebhookId((prev) => {
      if (prev || loaded.webhooks.length === 0) return prev;
      const preferred =
        loaded.webhooks.find((w) => w.signatureVerified && w.status !== "PROCESSED") ||
        loaded.webhooks[0];
      return preferred?.id ?? prev;
    });
    const recommended =
      loaded.actions.find((a) => a.allowed && a.recommended) ||
      loaded.actions.find((a) => a.allowed);
    if (recommended) {
      setSelectedAction((prev) => {
        const current = loaded.actions.find((a) => a.action === prev);
        return current?.allowed ? prev : recommended.action;
      });
    }
  }, []);

  const refreshDossier = useCallback(
    async (intentId: string) => {
      setLoadingDossier(true);
      setDossierError(null);
      try {
        const res = await fetch(`/api/app/payments/${intentId}`, {
          method: "GET",
          cache: "no-store",
        });
        const data = await res.json();
        if (!res.ok) {
          setDossierError(
            data.error || data.message || `Unable to load payment details (${res.status})`
          );
          setDossier(null);
          return;
        }
        applyResolvedDossier(data as PaymentInvestigationDossier);
      } catch {
        setDossierError("Network error while fetching server-side payment dossier.");
        setDossier(null);
      } finally {
        setLoadingDossier(false);
      }
    },
    [applyResolvedDossier]
  );

  useEffect(() => {
    let cancelled = false;
    async function fetchInitial() {
      try {
        const res = await fetch(`/api/app/payments/${row.id}`, {
          method: "GET",
          cache: "no-store",
        });
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok) {
          setDossierError(
            data.error || data.message || `Unable to load payment details (${res.status})`
          );
          setDossier(null);
          return;
        }
        setDossierError(null);
        applyResolvedDossier(data as PaymentInvestigationDossier);
      } catch {
        if (!cancelled) {
          setDossierError("Network error while fetching server-side payment dossier.");
          setDossier(null);
        }
      } finally {
        if (!cancelled) {
          setLoadingDossier(false);
        }
      }
    }
    void fetchInitial();
    return () => {
      cancelled = true;
    };
  }, [row.id, applyResolvedDossier]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isSubmitting) {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isSubmitting, onClose]);

  const fallbackActions = computeRecoveryActionMatrix({
    intentId: row.id,
    status: row.status,
    paymentMode: row.paymentMode ?? null,
    providerOrderId: row.providerOrderId,
    captureId: row.captureId,
    hasCompletedCaptureTx: Boolean(row.captureId),
    hasExpiredLease: row.hasExpiredLease,
    hasActiveLease: row.hasActiveLease,
    orderCreationLeaseExpiresAt: row.orderCreationLeaseExpiresAt,
    captureLeaseExpiresAt: row.captureLeaseExpiresAt,
    createdAt: row.createdAt,
    isOwner: Boolean(row.isOwner && isOwner),
    webhookEventId: row.webhookEventId,
    webhookStatus: row.webhookStatus,
    webhookSignatureVerified: row.webhookSignatureVerified,
    webhookIsExhausted: row.webhookIsExhausted,
  });

  const actionDescriptors: RecoveryActionDescriptor[] = dossier?.actions ?? fallbackActions;
  const activeDescriptor =
    actionDescriptors.find((a) => a.action === selectedAction) ?? actionDescriptors[0];

  const effectiveMode =
    dossier?.sellerContext.paymentMode || row.paymentMode || "MERCHANT";
  const warnings = dossier?.consistencyWarnings ?? [];

  const handleConfirmExecute = async () => {
    if (!row || !activeDescriptor?.allowed) return;
    setIsSubmitting(true);
    setFeedback(null);

    try {
      let csrfToken = "";
      try {
        const csrfRes = await fetch("/api/app/csrf");
        if (csrfRes.ok) {
          const csrfData = await csrfRes.json();
          csrfToken = csrfData.csrfToken || "";
        }
      } catch {
        // Fallback below
      }

      if (!csrfToken && typeof document !== "undefined") {
        const match = document.cookie
          .split(";")
          .map((c) => c.trim())
          .find(
            (c) =>
              c.startsWith("payroost_operator_csrf=") ||
              c.startsWith("__Host-payroost_operator_csrf=")
          );
        if (match) {
          csrfToken = match.split("=")[1];
        }
      }

      const webhookToSend =
        selectedAction === "REPROCESS_WEBHOOK"
          ? selectedWebhookId || row.webhookEventId || undefined
          : undefined;

      const res = await fetch("/api/app/payments/recovery", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          intentId: row.id,
          action: selectedAction,
          notes: recoveryNotes.trim() || undefined,
          webhookEventId: webhookToSend,
        }),
      });

      const data = await res.json();
      if (!res.ok) {
        setFeedback({
          tone: "error",
          message: data.error || data.message || `Recovery failed (${res.status})`,
        });
        setAwaitingConfirmation(false);
        return;
      }

      setFeedback({
        tone: "success",
        message: `${activeDescriptor.shortLabel} completed cleanly. Resulting status: ${
          data.resultingStatus || "RESOLVED"
        }`,
      });
      setAwaitingConfirmation(false);
      void refreshDossier(row.id);
      onRecovered();
    } catch (err) {
      setFeedback({
        tone: "error",
        message: err instanceof Error ? err.message : "Network error while executing recovery.",
      });
      setAwaitingConfirmation(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/55 p-0 backdrop-blur-xs sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="payment-investigation-title"
    >
      <div className="flex max-h-[100dvh] h-[100dvh] w-full max-w-4xl flex-col overflow-hidden rounded-none border-0 border-slate-200 bg-white shadow-2xl sm:h-auto sm:max-h-[90vh] sm:rounded-2xl sm:border">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-3.5 sm:px-6 sm:py-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2
                id="payment-investigation-title"
                className="font-display text-lg font-bold text-slate-900"
              >
                Payment Investigation & Recovery
              </h2>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ${
                  effectiveMode === "PLATFORM"
                    ? "bg-indigo-100 text-indigo-800"
                    : "bg-slate-100 text-slate-700"
                }`}
              >
                {effectiveMode} MODE
              </span>
              <span className="rounded-full bg-slate-100 px-2.5 py-0.5 font-mono text-[11px] font-semibold text-slate-700">
                {dossier?.intent.status || row.status}
              </span>
            </div>
            <p className="mt-1 truncate text-xs text-slate-500">
              {row.projectName} • {row.milestoneName} • {formatMoney(row.amountCents, row.currency)} • Intent{" "}
              <span className="font-mono text-slate-700">{row.id}</span>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
            aria-label="Close investigation dialog"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-slate-50/70 px-4 py-2 sm:px-6 sm:py-2.5">
          <div className="flex flex-wrap gap-1.5">
            {[
              { id: "overview" as const, label: "Overview & Ledger", icon: FileSearch },
              {
                id: "webhooks" as const,
                label: `Webhooks (${dossier?.webhooks.length ?? row.webhookCount ?? 0})`,
                icon: Webhook,
              },
              {
                id: "timeline" as const,
                label: `Audit Timeline (${dossier?.timeline.length ?? 0})`,
                icon: History,
              },
              { id: "recover" as const, label: "Recovery Controls", icon: RefreshCw },
            ].map((tab) => {
              const Icon = tab.icon;
              const isSelected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(tab.id);
                    setAwaitingConfirmation(false);
                  }}
                  className={`inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-2 text-xs font-semibold transition sm:py-1.5 ${
                    isSelected
                      ? "bg-slate-900 text-white shadow-xs"
                      : "text-slate-600 hover:bg-slate-200/60"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {tab.label}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={() => refreshDossier(row.id)}
            disabled={loadingDossier}
            className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:bg-slate-100"
          >
            {loadingDossier ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="h-3 w-3" />
            )}
            Refresh
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-4 py-4 sm:px-6 sm:py-5">
          {dossierError && (
            <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <span>{dossierError} — Showing cached table diagnostics.</span>
            </div>
          )}

          {warnings.length > 0 && (
            <div className="mb-4 rounded-xl border border-rose-200 bg-rose-50/80 p-3.5">
              <div className="flex items-center gap-1.5 text-xs font-bold text-rose-800">
                <ShieldAlert className="h-4 w-4" />
                Operational Warnings ({warnings.length})
              </div>
              <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs text-rose-700">
                {warnings.map((w, idx) => (
                  <li key={idx}>{w}</li>
                ))}
              </ul>
            </div>
          )}

          {/* TAB 1: OVERVIEW & LEDGER */}
          {activeTab === "overview" && (
            <div className="space-y-4">
              <div className="grid gap-3 md:grid-cols-2">
                {/* Payment & Provider IDs */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Intent & Provider Identifiers
                  </p>
                  <dl className="mt-2.5 space-y-1.5 text-xs">
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                      <dt className="text-slate-500">PayPal Order ID</dt>
                      <dd className="font-mono font-semibold text-slate-900">
                        {dossier?.intent.providerOrderId || row.providerOrderId || "None bound"}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                      <dt className="text-slate-500">PayPal Capture ID</dt>
                      <dd className="font-mono font-semibold text-slate-900">
                        {dossier?.intent.captureId || row.captureId || "—"}
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                      <dt className="text-slate-500">Amount / Currency</dt>
                      <dd className="font-semibold text-slate-900">
                        {formatMoney(row.amountCents, row.currency)} ({row.currency})
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                      <dt className="text-slate-500">Milestone Rule Status</dt>
                      <dd className="font-semibold text-slate-800">
                        {dossier?.intent.milestoneStatus || "Read-only"} (independent)
                      </dd>
                    </div>
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                      <dt className="text-slate-500">Created / Approved</dt>
                      <dd className="text-right text-slate-700">
                        {formatDateTime(row.createdAt)}
                        {dossier?.intent.buyerApprovedAt
                          ? ` / Approved ${formatDateTime(dossier.intent.buyerApprovedAt)}`
                          : ""}
                      </dd>
                    </div>
                  </dl>
                </div>

                {/* Mode & Seller Payee Context */}
                <div className="rounded-xl border border-slate-200 bg-slate-50/70 p-4">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Payee & Mode Attribution ({effectiveMode})
                  </p>
                  <dl className="mt-2.5 space-y-1.5 text-xs">
                    <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                      <dt className="text-slate-500">Expected Merchant ID</dt>
                      <dd className="font-mono font-semibold text-slate-900">
                        {dossier?.sellerContext.expectedMerchantId || row.payeeMerchantId || "—"}
                      </dd>
                    </div>
                    {effectiveMode === "PLATFORM" ? (
                      <>
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                          <dt className="text-slate-500">Seller Payer ID</dt>
                          <dd className="font-mono text-slate-800">
                            {dossier?.sellerContext.sellerPayerId || row.sellerPayerId || "Missing"}
                          </dd>
                        </div>
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                          <dt className="text-slate-500">Seller Onboarding</dt>
                          <dd className="font-semibold text-slate-800">
                            {dossier?.sellerContext.accountStatus || (loadingDossier ? "Loading..." : "Unknown")}
                          </dd>
                        </div>
                        <div className="flex flex-col gap-0.5 sm:flex-row sm:justify-between sm:gap-2">
                          <dt className="text-slate-500">Receivable / Email Verified</dt>
                          <dd className="text-slate-700">
                            {dossier?.sellerContext.paymentsReceivable === null
                              ? "—"
                              : `${dossier?.sellerContext.paymentsReceivable ? "Receivable" : "Blocked"} / ${
                                  dossier?.sellerContext.primaryEmailConfirmed ? "Confirmed" : "Unconfirmed"
                                }`}
                          </dd>
                        </div>
                      </>
                    ) : (
                      <div className="rounded-lg bg-white/80 p-2 text-[11px] text-slate-600">
                        Historical MERCHANT mode payment record. Settlement stays scoped to legacy
                        first-party PayPal merchant credentials without Platform Auth Assertions.
                      </div>
                    )}
                  </dl>
                </div>
              </div>

              {/* Leases & Idempotency State */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                    Concurrency Leases & Reconciliation Diagnostic
                  </p>
                  {row.hasExpiredLease ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2.5 py-0.5 text-[11px] font-bold text-amber-800">
                      <Clock className="h-3 w-3" />
                      Expired Lease Detected
                    </span>
                  ) : row.hasActiveLease ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-bold text-blue-800">
                      <Lock className="h-3 w-3" />
                      Active Worker Lease
                    </span>
                  ) : (
                    <span className="text-[11px] font-medium text-slate-500">No active leases</span>
                  )}
                </div>
                <div className="mt-2.5 grid gap-3 text-xs md:grid-cols-3">
                  <div>
                    <span className="text-slate-500">Order Creation Lease:</span>{" "}
                    <span className="font-mono text-slate-800">
                      {formatDateTime(dossier?.intent.orderCreationLeaseExpiresAt || row.orderCreationLeaseExpiresAt)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">Capture Lease:</span>{" "}
                    <span className="font-mono text-slate-800">
                      {formatDateTime(dossier?.intent.captureLeaseExpiresAt || row.captureLeaseExpiresAt)}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500">6h Idempotency Replay:</span>{" "}
                    <span className="font-semibold text-slate-800">
                      {row.idempotencyWindowExpired ? "Expired (> 6h)" : "Active (< 6h)"}
                    </span>
                  </div>
                </div>
                {(dossier?.intent.reconciliationReason || row.reconciliationReason) && (
                  <p className="mt-2.5 rounded-lg bg-amber-50 px-3 py-2 font-mono text-xs text-amber-900">
                    Reason: {dossier?.intent.reconciliationReason || row.reconciliationReason}
                  </p>
                )}
              </div>

              {/* Ledger Transactions */}
              <div className="rounded-xl border border-slate-200 bg-white p-4">
                <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">
                  Authoritative Payment Ledger ({dossier?.transactions.length ?? (row.captureId ? 1 : 0)})
                </p>
                {loadingDossier && !dossier ? (
                  <p className="mt-3 flex items-center gap-2 text-xs text-slate-500">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading ledger transactions...
                  </p>
                ) : dossier && dossier.transactions.length > 0 ? (
                  <div className="mt-2.5 divide-y divide-slate-100">
                    {dossier.transactions.map((tx) => (
                      <div key={tx.id} className="flex flex-col gap-2 py-2.5 text-xs sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:py-2">
                        <div className="min-w-0">
                          <span className="font-bold text-slate-900">{tx.transactionType}</span>{" "}
                          <span className="break-all rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-700">
                            {tx.providerReferenceId}
                          </span>
                          <span className="mt-1 block break-all text-slate-500 sm:ml-2 sm:mt-0 sm:inline">Payee: {tx.payeeMerchantId || "—"}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="font-semibold text-slate-900">
                            {formatMoney(tx.amountCents, tx.currency)}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                              tx.status === "COMPLETED"
                                ? "bg-emerald-100 text-emerald-800"
                                : "bg-amber-100 text-amber-800"
                            }`}
                          >
                            {tx.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className="mt-2 text-xs text-slate-500">No ledger transactions recorded yet for this intent.</p>
                )}
              </div>

              <div className="flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs text-slate-600">
                <Info className="h-4 w-4 shrink-0 text-slate-500" />
                <span>
                  {dossier?.milestoneIndependenceNotice ||
                    "Milestones are never automatically approved or completed by PayPal captures, webhooks, or operator recovery actions."}
                </span>
              </div>
            </div>
          )}

          {/* TAB 2: WEBHOOKS */}
          {activeTab === "webhooks" && (
            <div className="space-y-3">
              {loadingDossier && !dossier ? (
                <p className="flex items-center gap-2 text-xs text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading correlated webhook events...
                </p>
              ) : dossier && dossier.webhooks.length > 0 ? (
                dossier.webhooks.map((wh) => (
                  <div
                    key={wh.id}
                    className="rounded-xl border border-slate-200 bg-slate-50/70 p-4 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono font-bold text-slate-900">{wh.eventType}</span>
                        <span className="rounded bg-white px-2 py-0.5 font-mono text-[11px] text-slate-600">
                          {wh.providerEventId}
                        </span>
                        {wh.signatureVerified ? (
                          <span className="inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-bold text-emerald-800">
                            <ShieldCheck className="h-3 w-3" /> Verified
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 rounded-full bg-rose-100 px-2 py-0.5 text-[10px] font-bold text-rose-800">
                            <ShieldAlert className="h-3 w-3" /> Unverified
                          </span>
                        )}
                      </div>
                      <span
                        className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
                          wh.isExhausted || wh.operationalStatus === "FAILED"
                            ? "bg-rose-100 text-rose-800"
                            : wh.operationalStatus === "PROCESSED" || wh.operationalStatus === "DUPLICATE"
                              ? "bg-emerald-100 text-emerald-800"
                              : "bg-amber-100 text-amber-800"
                        }`}
                      >
                        {getWebhookDisplayLabel(wh.operationalStatus || wh.status)}
                      </span>
                    </div>

                    <div className="mt-2.5 grid grid-cols-1 gap-2 text-[11px] text-slate-600 sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        Attempts: <strong className="text-slate-900">{wh.attemptCount}</strong>
                      </div>
                      <div>
                        Duplicates: <strong className="text-slate-900">{wh.duplicateDeliveryCount}</strong>
                      </div>
                      <div>
                        Last processed:{" "}
                        <strong className="text-slate-800">{formatDateTime(wh.lastProcessedAt)}</strong>
                      </div>
                      <div>
                        Next retry:{" "}
                        <strong className="text-slate-800">{formatDateTime(wh.nextAttemptAt)}</strong>
                      </div>
                    </div>

                    {wh.errorDetails && (
                      <p className="mt-2 rounded-lg bg-rose-50 px-2.5 py-1.5 font-mono text-[11px] text-rose-800">
                        Sanitized reason: {wh.errorDetails}
                      </p>
                    )}

                    {isOwner && wh.signatureVerified && wh.status !== "PROCESSED" && (
                      <div className="mt-3 flex justify-end">
                        <Button
                          variant="secondary"
                          className="h-7 px-2.5 text-[11px]"
                          onClick={() => {
                            setSelectedWebhookId(wh.id);
                            setSelectedAction("REPROCESS_WEBHOOK");
                            setActiveTab("recover");
                            setAwaitingConfirmation(false);
                          }}
                        >
                          Select for Reprocessing
                        </Button>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
                  No correlated webhook events have been received for this payment intent yet.
                </div>
              )}
            </div>
          )}

          {/* TAB 3: AUDIT TIMELINE */}
          {activeTab === "timeline" && (
            <div className="space-y-2.5">
              {loadingDossier && !dossier ? (
                <p className="flex items-center gap-2 text-xs text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading audit history...
                </p>
              ) : dossier && dossier.timeline.length > 0 ? (
                dossier.timeline.map((ev) => (
                  <div
                    key={ev.id}
                    className="rounded-xl border border-slate-200 bg-white p-3.5 text-xs"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-mono font-bold text-slate-800">{ev.eventType}</span>
                      <span className="text-[11px] text-slate-400">{formatDateTime(ev.createdAt)}</span>
                    </div>
                    <p className="mt-1 text-slate-700">{ev.summary}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-500">
                      <span>Actor: {ev.actorLabel}</span>
                      {ev.metadata.previousStatus && ev.metadata.resultingStatus && (
                        <span className="font-mono">
                          {String(ev.metadata.previousStatus)} → {String(ev.metadata.resultingStatus)}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 p-8 text-center text-xs text-slate-500">
                  No payment recovery or state-transition audit events recorded for this intent yet.
                </div>
              )}
            </div>
          )}

          {/* TAB 4: RECOVERY CONTROLS */}
          {activeTab === "recover" && (
            <div className="space-y-4">
              {!isOwner ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-xs text-amber-800">
                  Read-only project member view: only the project owner can perform state-changing
                  payment recovery actions.
                </div>
              ) : awaitingConfirmation && activeDescriptor ? (
                <div className="rounded-2xl border-2 border-slate-900 bg-slate-50 p-5">
                  <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
                    <ShieldAlert className="h-4 w-4 text-amber-600" />
                    Confirm Recovery Execution
                  </div>
                  <p className="mt-2 text-xs text-slate-700">
                    {activeDescriptor.confirmationPrompt}
                  </p>
                  <div className="mt-3 rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600 space-y-1">
                    <div>
                      <span className="font-semibold text-slate-800">Action:</span>{" "}
                      {activeDescriptor.label}
                    </div>
                    <div>
                      <span className="font-semibold text-slate-800">Mode Scope:</span>{" "}
                      {effectiveMode}
                    </div>
                    <div>
                      <span className="font-semibold text-slate-800">Expected Impact:</span>{" "}
                      {activeDescriptor.impactSummary}
                    </div>
                    {recoveryNotes.trim() && (
                      <div>
                        <span className="font-semibold text-slate-800">Audit Notes:</span>{" "}
                        {recoveryNotes.trim()}
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:justify-end">
                    <Button
                      variant="secondary"
                      onClick={() => setAwaitingConfirmation(false)}
                      disabled={isSubmitting}
                      className="w-full text-xs sm:w-auto"
                    >
                      Back to Selection
                    </Button>
                    <Button
                      variant={activeDescriptor.destructive ? "danger" : "primary"}
                      onClick={handleConfirmExecute}
                      disabled={isSubmitting}
                      className="w-full text-xs sm:w-auto"
                    >
                      {isSubmitting ? (
                        <>
                          <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                          Executing...
                        </>
                      ) : (
                        "Confirm & Execute Recovery"
                      )}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  <div className="space-y-2">
                    {actionDescriptors.map((desc) => {
                      const isSelected = selectedAction === desc.action;
                      return (
                        <label
                          key={desc.action}
                          className={`flex items-start gap-3 rounded-xl border p-3.5 transition ${
                            !desc.allowed
                              ? "cursor-not-allowed border-slate-200 bg-slate-50/70 opacity-75"
                              : isSelected
                                ? "cursor-pointer border-slate-900 bg-slate-50 ring-1 ring-slate-900"
                                : "cursor-pointer border-slate-200 hover:bg-slate-50/80"
                          }`}
                        >
                          <input
                            type="radio"
                            name="r5RecoveryAction"
                            value={desc.action}
                            checked={isSelected}
                            disabled={!desc.allowed}
                            onChange={() => setSelectedAction(desc.action)}
                            className="mt-1 accent-slate-900"
                          />
                          <div className="min-w-0 flex-1 text-xs">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="font-semibold text-slate-900">{desc.label}</span>
                              {desc.recommended && desc.allowed && (
                                <span className="rounded-full bg-teal-100 px-2 py-0.5 text-[10px] font-bold text-teal-800">
                                  Recommended
                                </span>
                              )}
                              {!desc.allowed && (
                                <span className="rounded-full bg-slate-200 px-2 py-0.5 text-[10px] font-bold text-slate-600">
                                  Blocked
                                </span>
                              )}
                            </div>
                            <p className="mt-0.5 text-slate-500">{desc.description}</p>
                            {desc.blockedReason && (
                              <p className="mt-1 font-medium text-amber-700">
                                Precondition: {desc.blockedReason}
                              </p>
                            )}
                          </div>
                        </label>
                      );
                    })}
                  </div>

                  {selectedAction === "REPROCESS_WEBHOOK" && dossier && dossier.webhooks.length > 0 && (
                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Target Verified Webhook Event
                      </label>
                      <select
                        value={selectedWebhookId || ""}
                        onChange={(e) => setSelectedWebhookId(e.target.value)}
                        className="mt-1.5 w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-base text-slate-800 sm:text-xs"
                      >
                        {dossier.webhooks.map((w) => (
                          <option
                            key={w.id}
                            value={w.id}
                            disabled={!w.signatureVerified || w.status === "PROCESSED"}
                          >
                            {w.eventType} ({w.providerEventId}) —{" "}
                            {getWebhookDisplayLabel(w.operationalStatus || w.status)}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label
                      htmlFor="r5-recovery-notes"
                      className="block text-xs font-semibold text-slate-700"
                    >
                      Operator Audit Notes (Optional)
                    </label>
                    <textarea
                      id="r5-recovery-notes"
                      value={recoveryNotes}
                      onChange={(e) => setRecoveryNotes(e.target.value)}
                      rows={2}
                      maxLength={500}
                      placeholder="Document why recovery is being executed (stored in activity_events)..."
                      className="mt-1.5 w-full rounded-xl border border-slate-200 px-3 py-2 text-base focus:border-slate-400 focus:outline-none sm:text-xs"
                    />
                  </div>
                </>
              )}

              {feedback && (
                <div
                  className={`flex items-center gap-2 rounded-xl p-3 text-xs ${
                    feedback.tone === "success"
                      ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border border-rose-200 bg-rose-50 text-rose-800"
                  }`}
                >
                  {feedback.tone === "success" ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{feedback.message}</span>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex flex-col gap-2.5 border-t border-slate-200 bg-slate-50/70 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:px-6 sm:py-3.5">
          <div className="text-[11px] text-slate-500">
            <Eye className="mr-1 inline h-3.5 w-3.5" />
            All mutations require CSRF verification & server-side owner authorization.
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="secondary"
              onClick={onClose}
              disabled={isSubmitting}
              className="flex-1 text-xs sm:flex-initial"
            >
              Close
            </Button>
            {activeTab !== "recover" && isOwner && (
              <Button
                variant="primary"
                onClick={() => setActiveTab("recover")}
                className="flex-1 text-xs sm:flex-initial"
              >
                Open Recovery Controls
              </Button>
            )}
            {activeTab === "recover" && isOwner && !awaitingConfirmation && (
              <Button
                variant={activeDescriptor?.destructive ? "danger" : "primary"}
                onClick={() => setAwaitingConfirmation(true)}
                disabled={!activeDescriptor?.allowed || isSubmitting}
                className="flex-1 text-xs sm:flex-initial"
              >
                Review & Confirm
              </Button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
