"use client";

import { useMemo, useState, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { AllCommunityModule, type ColDef, type GridApi, type GridReadyEvent } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatMoney } from "@/lib/utils";
import {
  Search,
  HelpCircle,
  Loader2,
  RefreshCw,
} from "lucide-react";
import type { PaymentOperationRow, PaymentIntentStatus } from "@/features/payments/operations-data";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

interface PaymentOperationsGridProps {
  rows: PaymentOperationRow[];
  isOwner?: boolean;
}

export function PaymentOperationsGrid({ rows, isOwner = false }: PaymentOperationsGridProps) {
  const router = useRouter();
  const gridApiRef = useRef<GridApi<PaymentOperationRow> | null>(null);
  const [filterTab, setFilterTab] = useState<"ALL" | "ACTION_REQUIRED" | "IN_FLIGHT" | "COMPLETED" | "CANCELLED">("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedRow, setSelectedRow] = useState<PaymentOperationRow | null>(null);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [recoveryAction, setRecoveryAction] = useState<string>("RECONCILE");
  const [recoveryNotes, setRecoveryNotes] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionFeedback, setActionFeedback] = useState<{
    tone: "success" | "error";
    message: string;
  } | null>(null);

  const onGridReady = useCallback((params: GridReadyEvent<PaymentOperationRow>) => {
    gridApiRef.current = params.api;
  }, []);

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const value = e.target.value;
      setSearchQuery(value);
      if (gridApiRef.current) {
        gridApiRef.current.setGridOption("quickFilterText", value);
      }
    },
    []
  );

  // Filtered rows for tabs
  const filteredRows = useMemo(() => {
    switch (filterTab) {
      case "ACTION_REQUIRED":
        return rows.filter(
          (r) => r.status === "RECONCILIATION_REQUIRED" || r.hasExpiredLease
        );
      case "IN_FLIGHT":
        return rows.filter((r) =>
          ["ORDER_CREATING", "ORDER_CREATED", "BUYER_APPROVED", "CAPTURING", "RECONCILING"].includes(
            r.status
          )
        );
      case "COMPLETED":
        return rows.filter((r) => r.status === "COMPLETED");
      case "CANCELLED":
        return rows.filter((r) => r.status === "CANCELLED" || r.status === "FAILED");
      case "ALL":
      default:
        return rows;
    }
  }, [rows, filterTab]);

  const openRecoveryModal = useCallback((row: PaymentOperationRow) => {
    setSelectedRow(row);
    setActionFeedback(null);
    setRecoveryNotes("");

    // Set smart default action based on row status
    if (row.status === "RECONCILIATION_REQUIRED") {
      setRecoveryAction("RECONCILE");
    } else if (row.hasExpiredLease) {
      setRecoveryAction("CLEAR_EXPIRED_LEASE");
    } else if (row.status === "ORDER_CREATED" || row.status === "BUYER_APPROVED") {
      setRecoveryAction("ESCALATE_MANUAL");
    } else {
      setRecoveryAction("RECONCILE");
    }

    setIsModalOpen(true);
  }, []);

  const executeRecoveryAction = async () => {
    if (!selectedRow) return;

    setIsSubmitting(true);
    setActionFeedback(null);

    try {
      // 1. Fetch CSRF token
      let csrfToken = "";
      try {
        const csrfRes = await fetch("/api/app/csrf");
        if (csrfRes.ok) {
          const csrfData = await csrfRes.json();
          csrfToken = csrfData.csrfToken || "";
        }
      } catch {
        // Fallback: Check document.cookie
      }

      if (!csrfToken && typeof document !== "undefined") {
        const match = document.cookie
          .split(";")
          .map((c) => c.trim())
          .find((c) => c.startsWith("payroost_operator_csrf=") || c.startsWith("__Host-payroost_operator_csrf="));
        if (match) {
          csrfToken = match.split("=")[1];
        }
      }

      // 2. Dispatch recovery mutation
      const res = await fetch("/api/app/payments/recovery", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          intentId: selectedRow.id,
          action: recoveryAction,
          notes: recoveryNotes || undefined,
          webhookEventId: selectedRow.webhookEventId || undefined,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setActionFeedback({
          tone: "error",
          message: data.error || data.message || `Recovery operation failed (${res.status})`,
        });
        setIsSubmitting(false);
        return;
      }

      setActionFeedback({
        tone: "success",
        message: `Operation ${recoveryAction} completed successfully. Result: ${data.resultingStatus || "RESOLVED"}`,
      });

      setIsSubmitting(false);

      // Refresh data
      setTimeout(() => {
        setIsModalOpen(false);
        router.refresh();
      }, 1200);
    } catch (err) {
      setActionFeedback({
        tone: "error",
        message: err instanceof Error ? err.message : "Network error during recovery request",
      });
      setIsSubmitting(false);
    }
  };

  const columns = useMemo<ColDef<PaymentOperationRow>[]>(
    () => [
      {
        field: "reference",
        headerName: "Reference / Intent",
        minWidth: 160,
        filter: "agTextColumnFilter",
        cellClass: "font-mono font-semibold text-ink-900 text-xs",
        cellRenderer: ({ value, data }: { value?: string; data?: PaymentOperationRow }) => {
          if (!data) return value || "—";
          return (
            <div className="flex flex-col py-1">
              <span className="font-mono text-xs text-ink-900">{value || data.id.slice(0, 8)}</span>
              {data.providerOrderId && (
                <span className="font-mono text-[10px] text-teal-700">Order: {data.providerOrderId}</span>
              )}
            </div>
          );
        },
      },
      {
        field: "projectName",
        headerName: "Project",
        minWidth: 170,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value?: string; data?: PaymentOperationRow }) => (
          <div className="flex flex-col py-1">
            <span className="font-medium text-ink-900">{value || "—"}</span>
            <span className="text-[11px] text-ink-500">Client: {data?.clientName || "—"}</span>
          </div>
        ),
      },
      {
        field: "milestoneName",
        headerName: "Milestone",
        minWidth: 160,
        filter: "agTextColumnFilter",
      },
      {
        headerName: "Amount",
        minWidth: 120,
        type: "numericColumn",
        valueGetter: ({ data }) => {
          if (!data) return 0;
          return data.amountCents || (data as unknown as { amountMinor?: number }).amountMinor || 0;
        },
        valueFormatter: ({ value, data }) => {
          if (!data) return "—";
          const currency = data.currency || "USD";
          return formatMoney(value as number, currency);
        },
      },
      {
        field: "status",
        headerName: "State / Provider Status",
        minWidth: 190,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value: PaymentIntentStatus; data?: PaymentOperationRow }) => {
          let tone: "success" | "warning" | "info" | "neutral" = "info";
          let label = value as string;
          let extra = "";

          switch (value) {
            case "COMPLETED":
              tone = "success";
              label = "Captured (Provider Verified)";
              break;
            case "RECONCILIATION_REQUIRED":
              tone = "warning";
              label = "Reconciliation Required";
              extra = "bg-rose-50 text-rose-800 ring-rose-200";
              break;
            case "ORDER_CREATING":
              tone = "info";
              label = "Creating Order";
              break;
            case "ORDER_CREATED":
              tone = "info";
              label = "Order Created";
              break;
            case "BUYER_APPROVED":
              tone = "warning";
              label = "Buyer Approved";
              break;
            case "CAPTURING":
              tone = "warning";
              label = "Capturing...";
              break;
            case "CANCELLED":
              tone = "neutral";
              label = "Cancelled (Inactive)";
              break;
            case "FAILED":
              tone = "neutral";
              label = "Failed";
              extra = "bg-rose-50 text-rose-800 ring-rose-200";
              break;
            default:
              label = (value as string) || "Unknown";
          }

          return (
            <div className="flex flex-col gap-0.5 py-1">
              <div className="flex items-center gap-1">
                <Badge tone={tone} className={extra}>
                  {label}
                </Badge>
                {data?.paymentMode === "PLATFORM" && (
                  <span className="rounded bg-teal-50 px-1.5 py-0.5 text-[10px] font-semibold text-teal-800">
                    Platform
                  </span>
                )}
                {data?.paymentMode === "MERCHANT" && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600">
                    Merchant (Legacy)
                  </span>
                )}
              </div>
              {data?.hasExpiredLease && (
                <span className="text-[10px] font-semibold text-rose-600">Lease Expired</span>
              )}
            </div>
          );
        },
      },
      {
        field: "reconciliationReason",
        headerName: "Reason / Diagnostics",
        minWidth: 180,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value }: { value?: string | null }) => {
          if (!value) return <span className="text-ink-400">—</span>;
          return (
            <span
              className="inline-block max-w-[170px] truncate rounded bg-ink-50 px-1.5 py-0.5 font-mono text-[11px] text-ink-700"
              title={value}
            >
              {value}
            </span>
          );
        },
      },
      {
        field: "captureId",
        headerName: "Capture ID",
        minWidth: 140,
        filter: "agTextColumnFilter",
        cellClass: "font-mono text-xs text-ink-600",
        valueFormatter: ({ value }) => (value ? (value as string) : "—"),
      },
      {
        field: "webhookStatus",
        headerName: "Webhook",
        minWidth: 165,
        filter: "agTextColumnFilter",
        cellRenderer: ({
          value,
          data,
        }: {
          value?: string | null;
          data?: PaymentOperationRow;
        }) => {
          if (!value) return <span className="text-ink-400">—</span>;

          let tone: "success" | "warning" | "info" | "neutral" = "info";
          let label = value;
          switch (value.toUpperCase()) {
            case "PROCESSED":
              tone = "success";
              label = "Processed";
              break;
            case "DUPLICATE":
              tone = "neutral";
              label = "Duplicate";
              break;
            case "RECEIVED":
              tone = "info";
              label = "Received";
              break;
            case "VERIFIED":
              tone = "info";
              label = "Verified";
              break;
            case "PROCESSING":
              tone = "warning";
              label = "Processing";
              break;
            case "FAILED":
              tone = "warning";
              label = "Failed";
              break;
            case "REQUIRES_RECONCILIATION":
              tone = "warning";
              label = "Requires reconciliation";
              break;
          }

          return (
            <div className="flex flex-col gap-0.5 py-1">
              <Badge tone={tone}>{label}</Badge>
              {data?.webhookEventType && (
                <span className="truncate font-mono text-[10px] text-ink-500" title={data.webhookEventType}>
                  {data.webhookEventType}
                </span>
              )}
            </div>
          );
        },
      },
      {
        field: "createdAt",
        headerName: "Created",
        minWidth: 155,
        filter: "agDateColumnFilter",
        valueGetter: ({ data }) => {
          if (!data) return "";
          return data.createdAt || (data as unknown as { transactionDate?: string }).transactionDate || "";
        },
        valueFormatter: ({ value }) =>
          value ? dateFormatter.format(new Date(value as string)) : "—",
      },
      {
        headerName: "Actions",
        minWidth: 120,
        pinned: "right",
        sortable: false,
        filter: false,
        cellRenderer: ({ data }: { data?: PaymentOperationRow }) => {
          if (!data) return null;
          const hasOwnerAuth = Boolean(isOwner || data.isOwner);
          const canAct =
            hasOwnerAuth &&
            data.status !== "COMPLETED" &&
            (data.status === "RECONCILIATION_REQUIRED" ||
              data.hasExpiredLease ||
              data.status === "ORDER_CREATED" ||
              data.status === "BUYER_APPROVED" ||
              data.status === "ORDER_CREATING" ||
              data.status === "CAPTURING");

          if (!canAct) {
            return (
              <span className="text-xs text-ink-400" title={hasOwnerAuth ? "No action required" : "Read-only"}>
                {data.status === "COMPLETED" ? "Locked" : "Read-only"}
              </span>
            );
          }

          return (
            <Button
              variant="secondary"
              className="h-7 px-2.5 text-xs text-teal-700 hover:text-teal-900"
              onClick={() => openRecoveryModal(data)}
            >
              Action
            </Button>
          );
        },
      },
    ],
    [openRecoveryModal, isOwner]
  );

  return (
    <div className="flex flex-col gap-4">
      {/* Top Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        {/* Quick Filter Tabs */}
        <div className="flex flex-wrap gap-1 rounded-xl bg-ink-100 p-1">
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "ALL" ? "bg-white text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("ALL")}
          >
            All ({rows.length})
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "ACTION_REQUIRED"
                ? "bg-rose-500 text-white shadow-sm"
                : "text-rose-700 hover:text-rose-900"
            }`}
            onClick={() => setFilterTab("ACTION_REQUIRED")}
          >
            Needs Action (
            {
              rows.filter((r) => r.status === "RECONCILIATION_REQUIRED" || r.hasExpiredLease).length
            }
            )
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "IN_FLIGHT" ? "bg-white text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("IN_FLIGHT")}
          >
            In-Flight (
            {
              rows.filter((r) =>
                ["ORDER_CREATING", "ORDER_CREATED", "BUYER_APPROVED", "CAPTURING"].includes(
                  r.status
                )
              ).length
            }
            )
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "COMPLETED" ? "bg-white text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("COMPLETED")}
          >
            Captured ({rows.filter((r) => r.status === "COMPLETED").length})
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "CANCELLED" ? "bg-white text-ink-950 shadow-sm" : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("CANCELLED")}
          >
            Cancelled ({rows.filter((r) => r.status === "CANCELLED" || r.status === "FAILED").length})
          </button>
        </div>

        {/* Search input & Refresh */}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-ink-400" />
            <input
              type="text"
              placeholder="Search reference, project, order..."
              value={searchQuery}
              onChange={handleSearchChange}
              className="h-9 w-60 rounded-xl border border-ink-200 bg-white pl-8 pr-3 text-xs text-ink-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
          </div>
          <Button
            variant="secondary"
            className="h-9 px-3 text-xs text-ink-700"
            onClick={() => router.refresh()}
            title="Refresh database records"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* Main Grid View */}
      {filteredRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-200 bg-ink-50/50 py-16 text-center">
          <HelpCircle className="h-10 w-10 text-ink-400" />
          <h3 className="mt-3 text-sm font-semibold text-ink-900">No payment operations records found</h3>
          <p className="mt-1 max-w-sm text-xs text-ink-600">
            {filterTab !== "ALL"
              ? "No records match the selected filter category."
              : "Payment intents and ledger transactions will appear here once agreements are signed and portal checkout is initiated."}
          </p>
          {filterTab !== "ALL" && (
            <Button
              variant="secondary"
              className="mt-4 text-xs"
              onClick={() => setFilterTab("ALL")}
            >
              Clear filter
            </Button>
          )}
        </div>
      ) : (
        <div
          aria-label="Payment Operations transaction table"
          className="payroost-grid ag-theme-quartz h-[520px] w-full overflow-hidden rounded-xl border border-ink-100"
        >
          <AgGridProvider modules={[AllCommunityModule]}>
            <AgGridReact<PaymentOperationRow>
              columnDefs={columns}
              defaultColDef={{
                sortable: true,
                filter: true,
                resizable: true,
              }}
              getRowId={({ data }) => data.id}
              pagination
              paginationPageSize={10}
              paginationPageSizeSelector={[10, 25, 50, 100]}
              rowData={filteredRows}
              suppressCellFocus={false}
              onGridReady={onGridReady}
            />
          </AgGridProvider>
        </div>
      )}

      {/* Operator Recovery Action Modal */}
      {isModalOpen && selectedRow && (
        <div
          role="dialog"
          aria-modal="true"
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink-950/40 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-lg rounded-2xl border border-ink-200 bg-white p-6 shadow-xl">
            <div className="flex items-start justify-between">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-teal-700">
                  Payment Recovery & Operations
                </span>
                <h3 className="mt-1 text-lg font-bold text-ink-950">
                  Manage Payment Intent
                </h3>
              </div>
              <button
                type="button"
                className="text-ink-400 hover:text-ink-600"
                onClick={() => setIsModalOpen(false)}
                disabled={isSubmitting}
              >
                ✕
              </button>
            </div>

            {/* Target Details */}
            <div className="mt-4 rounded-xl border border-ink-100 bg-ink-50/70 p-3.5 text-xs">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <span className="text-ink-500">Project:</span>{" "}
                  <span className="font-semibold text-ink-900">{selectedRow.projectName}</span>
                </div>
                <div>
                  <span className="text-ink-500">Milestone:</span>{" "}
                  <span className="font-semibold text-ink-900">{selectedRow.milestoneName}</span>
                </div>
                <div>
                  <span className="text-ink-500">Current Status:</span>{" "}
                  <Badge tone="warning" className="ml-1 text-[10px]">
                    {selectedRow.status}
                  </Badge>
                </div>
                <div>
                  <span className="text-ink-500">Amount:</span>{" "}
                  <span className="font-semibold text-ink-900">
                    {formatMoney(selectedRow.amountCents, selectedRow.currency)}
                  </span>
                </div>
                {selectedRow.providerOrderId && (
                  <div className="col-span-2">
                    <span className="text-ink-500">PayPal Order ID:</span>{" "}
                    <span className="font-mono text-ink-800">{selectedRow.providerOrderId}</span>
                  </div>
                )}
                {selectedRow.reconciliationReason && (
                  <div className="col-span-2">
                    <span className="text-ink-500">Diagnostic Reason:</span>{" "}
                    <span className="font-mono text-rose-700">{selectedRow.reconciliationReason}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Recovery Action Options */}
            <div className="mt-5">
              <label className="block text-xs font-semibold text-ink-900">
                Select Recovery Operation
              </label>
              <div className="mt-2 space-y-2">
                <label className="flex items-start gap-2.5 rounded-xl border border-ink-200 p-2.5 hover:bg-ink-50 cursor-pointer">
                  <input
                    type="radio"
                    name="recoveryAction"
                    value="RECONCILE"
                    checked={recoveryAction === "RECONCILE"}
                    onChange={(e) => setRecoveryAction(e.target.value)}
                    className="mt-0.5 text-teal-600 focus:ring-teal-500"
                  />
                  <div>
                    <span className="block text-xs font-semibold text-ink-900">
                      Authoritative Provider Reconciliation
                    </span>
                    <span className="block text-[11px] text-ink-600">
                      Inquires PayPal REST API directly, validates purchase units, and safely completes or resets state.
                    </span>
                  </div>
                </label>

                {selectedRow.hasExpiredLease && (
                  <label className="flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/40 p-2.5 hover:bg-amber-50 cursor-pointer">
                    <input
                      type="radio"
                      name="recoveryAction"
                      value="CLEAR_EXPIRED_LEASE"
                      checked={recoveryAction === "CLEAR_EXPIRED_LEASE"}
                      onChange={(e) => setRecoveryAction(e.target.value)}
                      className="mt-0.5 text-teal-600 focus:ring-teal-500"
                    />
                    <div>
                      <span className="block text-xs font-semibold text-amber-900">
                        Clear Expired Worker Lease
                      </span>
                      <span className="block text-[11px] text-amber-700">
                        Verifies provider state, resets expired worker lease tokens, and moves intent to reconciliation.
                      </span>
                    </div>
                  </label>
                )}

                {!selectedRow.providerOrderId && selectedRow.status === "RECONCILIATION_REQUIRED" && (
                  <label className="flex items-start gap-2.5 rounded-xl border border-ink-200 p-2.5 hover:bg-ink-50 cursor-pointer">
                    <input
                      type="radio"
                      name="recoveryAction"
                      value="RETRY_ORDER_CREATION"
                      checked={recoveryAction === "RETRY_ORDER_CREATION"}
                      onChange={(e) => setRecoveryAction(e.target.value)}
                      className="mt-0.5 text-teal-600 focus:ring-teal-500"
                    />
                    <div>
                      <span className="block text-xs font-semibold text-ink-900">
                        Retry Order Creation (Idempotent Replay)
                      </span>
                      <span className="block text-[11px] text-ink-600">
                        Replays original order creation with identical PayPal-Request-Id within 6h retention window.
                      </span>
                    </div>
                  </label>
                )}

                {selectedRow.status !== "RECONCILIATION_REQUIRED" && (
                  <label className="flex items-start gap-2.5 rounded-xl border border-ink-200 p-2.5 hover:bg-ink-50 cursor-pointer">
                    <input
                      type="radio"
                      name="recoveryAction"
                      value="ESCALATE_MANUAL"
                      checked={recoveryAction === "ESCALATE_MANUAL"}
                      onChange={(e) => setRecoveryAction(e.target.value)}
                      className="mt-0.5 text-teal-600 focus:ring-teal-500"
                    />
                    <div>
                      <span className="block text-xs font-semibold text-ink-900">
                        Escalate for Manual Investigation
                      </span>
                      <span className="block text-[11px] text-ink-600">
                        Transitions in-flight intent to RECONCILIATION_REQUIRED to pause client portal checkout safely.
                      </span>
                    </div>
                  </label>
                )}

                <label className="flex items-start gap-2.5 rounded-xl border border-rose-200 bg-rose-50/30 p-2.5 hover:bg-rose-50 cursor-pointer">
                  <input
                    type="radio"
                    name="recoveryAction"
                    value="CANCEL_INACTIVE"
                    checked={recoveryAction === "CANCEL_INACTIVE"}
                    onChange={(e) => setRecoveryAction(e.target.value)}
                    className="mt-0.5 text-rose-600 focus:ring-rose-500"
                  />
                  <div>
                    <span className="block text-xs font-semibold text-rose-900">
                      Cancel Inactive Intent (Provider Evidence Required)
                    </span>
                    <span className="block text-[11px] text-rose-700">
                      Only permitted if provider confirms order is VOIDED/EXPIRED or verified ticket is supplied. Unblocks milestone.
                    </span>
                  </div>
                </label>

                {selectedRow.webhookEventId && (
                  <label className="flex items-start gap-2.5 rounded-xl border border-teal-200 bg-teal-50/30 p-2.5 hover:bg-teal-50 cursor-pointer">
                    <input
                      type="radio"
                      name="recoveryAction"
                      value="REPROCESS_WEBHOOK"
                      checked={recoveryAction === "REPROCESS_WEBHOOK"}
                      onChange={(e) => setRecoveryAction(e.target.value)}
                      className="mt-0.5 text-teal-600 focus:ring-teal-500"
                    />
                    <div>
                      <span className="block text-xs font-semibold text-teal-900">
                        Reprocess Correlated Webhook Event
                      </span>
                      <span className="block text-[11px] text-teal-700">
                        Reruns reconciliation against recorded webhook event {selectedRow.webhookEventId.slice(0, 8)}.
                      </span>
                    </div>
                  </label>
                )}
              </div>
            </div>

            {/* Notes / Documentation field */}
            <div className="mt-4">
              <label className="block text-xs font-semibold text-ink-800">
                Audit Notes / Support Ticket Reference {recoveryAction === "CANCEL_INACTIVE" && !selectedRow.providerOrderId ? "(Required)" : "(Optional)"}
              </label>
              <textarea
                rows={2}
                placeholder="Document reason for operator recovery or provide support ticket reference..."
                value={recoveryNotes}
                onChange={(e) => setRecoveryNotes(e.target.value)}
                className="mt-1 w-full rounded-xl border border-ink-200 p-2 text-xs text-ink-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
              />
            </div>

            {/* Feedback Alert */}
            {actionFeedback && (
              <div
                className={`mt-4 rounded-xl p-3 text-xs ${
                  actionFeedback.tone === "success"
                    ? "border border-emerald-200 bg-emerald-50 text-emerald-800"
                    : "border border-rose-200 bg-rose-50 text-rose-800"
                }`}
              >
                {actionFeedback.message}
              </div>
            )}

            {/* Modal Actions */}
            <div className="mt-6 flex items-center justify-end gap-2.5">
              <Button
                variant="secondary"
                onClick={() => setIsModalOpen(false)}
                disabled={isSubmitting}
                className="text-xs"
              >
                Cancel
              </Button>
              <Button
                variant={recoveryAction === "CANCEL_INACTIVE" ? "danger" : "primary"}
                onClick={executeRecoveryAction}
                disabled={isSubmitting}
                className="text-xs"
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    Executing...
                  </>
                ) : (
                  "Execute Recovery"
                )}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
