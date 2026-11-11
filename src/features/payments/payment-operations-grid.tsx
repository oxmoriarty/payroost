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
  RefreshCw,
  AlertTriangle,
  Eye,
  Wrench,
  Clock,
} from "lucide-react";
import type { PaymentOperationRow } from "@/features/payments/operations-data";
import {
  PaymentInvestigationModal,
  getWebhookDisplayLabel,
} from "@/features/payments/payment-investigation-modal";

const dateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

type QuickTab = "ALL" | "ACTION_REQUIRED" | "IN_FLIGHT" | "COMPLETED" | "CANCELLED";

interface PaymentOperationsGridProps {
  rows: PaymentOperationRow[];
  isOwner?: boolean;
}

export function PaymentOperationsGrid({ rows, isOwner = false }: PaymentOperationsGridProps) {
  const router = useRouter();
  const gridApiRef = useRef<GridApi<PaymentOperationRow> | null>(null);

  const [filterTab, setFilterTab] = useState<QuickTab>("ALL");
  const [searchQuery, setSearchQuery] = useState("");
  const [modeFilter, setModeFilter] = useState<"ALL" | "PLATFORM" | "MERCHANT">("ALL");
  const [currencyFilter, setCurrencyFilter] = useState<string>("ALL");
  const [payeeFilter, setPayeeFilter] = useState<string>("ALL");
  const [webhookFilter, setWebhookFilter] = useState<string>("ALL");
  const [dateFrom, setDateFrom] = useState<string>("");
  const [dateTo, setDateTo] = useState<string>("");

  const [selectedRow, setSelectedRow] = useState<PaymentOperationRow | null>(null);
  const [modalInitialView, setModalInitialView] = useState<"inspect" | "recover">("inspect");
  const [isModalOpen, setIsModalOpen] = useState(false);

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

  const distinctCurrencies = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .map((r) => (r.currency || "").trim().toUpperCase())
            .filter((c) => c.length > 0)
        )
      ).sort(),
    [rows]
  );

  const distinctPayees = useMemo(
    () =>
      Array.from(
        new Set(
          rows
            .map((r) => (r.payeeMerchantId || "").trim())
            .filter((p) => p.length > 0)
        )
      ).sort(),
    [rows]
  );

  const hasAdvancedFilters =
    modeFilter !== "ALL" ||
    currencyFilter !== "ALL" ||
    payeeFilter !== "ALL" ||
    webhookFilter !== "ALL" ||
    dateFrom.length > 0 ||
    dateTo.length > 0 ||
    searchQuery.trim().length > 0;

  const resetAllFilters = useCallback(() => {
    setFilterTab("ALL");
    setModeFilter("ALL");
    setCurrencyFilter("ALL");
    setPayeeFilter("ALL");
    setWebhookFilter("ALL");
    setDateFrom("");
    setDateTo("");
    setSearchQuery("");
    if (gridApiRef.current) {
      gridApiRef.current.setGridOption("quickFilterText", "");
    }
  }, []);

  // Filtered rows across status tabs & operational filter bar
  const filteredRows = useMemo(() => {
    let base = rows;

    switch (filterTab) {
      case "ACTION_REQUIRED":
        base = base.filter(
          (r) =>
            r.status === "RECONCILIATION_REQUIRED" ||
            r.hasExpiredLease ||
            Boolean(r.webhookIsExhausted) ||
            Boolean(r.hasInconsistency)
        );
        break;
      case "IN_FLIGHT":
        base = base.filter((r) =>
          ["ORDER_CREATING", "ORDER_CREATED", "BUYER_APPROVED", "CAPTURING", "RECONCILING"].includes(
            r.status
          )
        );
        break;
      case "COMPLETED":
        base = base.filter((r) => r.status === "COMPLETED");
        break;
      case "CANCELLED":
        base = base.filter((r) => r.status === "CANCELLED" || r.status === "FAILED");
        break;
      case "ALL":
      default:
        break;
    }

    if (modeFilter !== "ALL") {
      base = base.filter((r) => (r.paymentMode || "MERCHANT") === modeFilter);
    }

    if (currencyFilter !== "ALL") {
      base = base.filter((r) => (r.currency || "").toUpperCase() === currencyFilter);
    }

    if (payeeFilter !== "ALL") {
      base = base.filter((r) => (r.payeeMerchantId || "").trim() === payeeFilter);
    }

    if (webhookFilter !== "ALL") {
      if (webhookFilter === "NONE") {
        base = base.filter((r) => !r.webhookStatus);
      } else if (webhookFilter === "EXHAUSTED") {
        base = base.filter((r) => Boolean(r.webhookIsExhausted) || r.webhookStatus === "EXHAUSTED");
      } else {
        base = base.filter((r) => (r.webhookStatus || "").toUpperCase() === webhookFilter);
      }
    }

    if (dateFrom) {
      const fromMs = new Date(`${dateFrom}T00:00:00.000Z`).getTime();
      if (Number.isFinite(fromMs)) {
        base = base.filter((r) => new Date(r.createdAt).getTime() >= fromMs);
      }
    }

    if (dateTo) {
      const toMs = new Date(`${dateTo}T23:59:59.999Z`).getTime();
      if (Number.isFinite(toMs)) {
        base = base.filter((r) => new Date(r.createdAt).getTime() <= toMs);
      }
    }

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      base = base.filter((r) => {
        const hay = [
          r.id,
          r.reference,
          r.projectName,
          r.clientName,
          r.milestoneName,
          r.providerOrderId,
          r.captureId,
          r.payeeMerchantId,
          r.sellerPayerId,
          r.paymentMode,
          r.status,
          r.webhookStatus,
          r.webhookEventType,
          r.webhookProviderEventId,
          r.reconciliationReason,
          r.webhookErrorDetails,
        ]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        return hay.includes(q);
      });
    }

    return base;
  }, [
    rows,
    filterTab,
    modeFilter,
    currencyFilter,
    payeeFilter,
    webhookFilter,
    dateFrom,
    dateTo,
    searchQuery,
  ]);

  const openModal = useCallback((row: PaymentOperationRow, view: "inspect" | "recover") => {
    setSelectedRow(row);
    setModalInitialView(view);
    setIsModalOpen(true);
  }, []);

  const columns = useMemo<ColDef<PaymentOperationRow>[]>(
    () => [
      {
        field: "reference",
        headerName: "Reference / Intent",
        minWidth: 185,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value?: string; data?: PaymentOperationRow }) => {
          if (!data) return value || "—";
          return (
            <div className="flex flex-col py-1 leading-tight">
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-xs font-semibold text-ink-900">
                  {value || data.id.slice(0, 8)}
                </span>
                {data.hasInconsistency && (
                  <span title="Ledger or webhook consistency warning detected">
                    <AlertTriangle className="h-3.5 w-3.5 text-rose-600" />
                  </span>
                )}
              </div>
              <span className="font-mono text-[10px] text-ink-500">
                Intent: {data.id.slice(0, 8)}…
              </span>
              {data.providerOrderId && (
                <span className="font-mono text-[10px] text-teal-700">
                  Order: {data.providerOrderId}
                </span>
              )}
            </div>
          );
        },
      },
      {
        field: "projectName",
        headerName: "Project & Milestone",
        minWidth: 195,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value?: string; data?: PaymentOperationRow }) => (
          <div className="flex flex-col py-1 leading-tight">
            <span className="font-medium text-ink-900">{value || "—"}</span>
            <span className="text-[11px] text-ink-600">{data?.milestoneName || "—"}</span>
            <span className="text-[10px] text-ink-400">Client: {data?.clientName || "—"}</span>
          </div>
        ),
      },
      {
        field: "paymentMode",
        headerName: "Mode & Payee",
        minWidth: 185,
        filter: "agTextColumnFilter",
        cellRenderer: ({ data }: { data?: PaymentOperationRow }) => {
          if (!data) return "—";
          const mode = data.paymentMode || "MERCHANT";
          return (
            <div className="flex flex-col gap-0.5 py-1 leading-tight">
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-bold uppercase ${
                    mode === "PLATFORM"
                      ? "bg-indigo-100 text-indigo-800"
                      : "bg-slate-100 text-slate-700"
                  }`}
                >
                  {mode}
                </span>
                <span className="font-mono text-[11px] text-ink-800">
                  {data.payeeMerchantId || "—"}
                </span>
              </div>
              {mode === "PLATFORM" && (
                <span className="font-mono text-[10px] text-ink-500">
                  Payer ID: {data.sellerPayerId ? `${data.sellerPayerId.slice(0, 10)}…` : "Unset"}
                </span>
              )}
            </div>
          );
        },
      },
      {
        field: "amountCents",
        headerName: "Amount",
        minWidth: 120,
        filter: "agNumberColumnFilter",
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
        headerName: "State / Leases",
        minWidth: 205,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value?: string; data?: PaymentOperationRow }) => {
          const status = value || "UNKNOWN";
          let tone: "success" | "warning" | "info" | "neutral" = "neutral";
          let label = status;

          switch (status) {
            case "COMPLETED":
              tone = "success";
              label = "Captured & Verified";
              break;
            case "BUYER_APPROVED":
              tone = "info";
              label = "Buyer Approved";
              break;
            case "CAPTURING":
            case "RECONCILING":
            case "ORDER_CREATING":
              tone = "warning";
              label = status.replace("_", " ");
              break;
            case "ORDER_CREATED":
              tone = "info";
              label = "Order Created";
              break;
            case "RECONCILIATION_REQUIRED":
              tone = "warning";
              label = "Needs Reconciliation";
              break;
            case "CANCELLED":
            case "FAILED":
              tone = "neutral";
              label = status;
              break;
          }

          return (
            <div className="flex flex-col gap-0.5 py-1 leading-tight">
              <div className="flex flex-wrap items-center gap-1">
                <Badge tone={tone} className="w-fit text-[11px]">
                  {label}
                </Badge>
                {data?.hasExpiredLease && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-rose-100 px-1.5 py-0.5 text-[10px] font-bold text-rose-700">
                    <Clock className="h-2.5 w-2.5" /> Expired Lease
                  </span>
                )}
              </div>
              {data?.reconciliationReason && (
                <span className="truncate font-mono text-[10px] text-amber-800" title={data.reconciliationReason}>
                  {data.reconciliationReason}
                </span>
              )}
            </div>
          );
        },
      },
      {
        field: "webhookStatus",
        headerName: "Webhook & Retries",
        minWidth: 215,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value?: string | null; data?: PaymentOperationRow }) => {
          if (!value && !data?.webhookCount) return <span className="text-ink-400">—</span>;

          const statusUpper = (value || "").toUpperCase();
          let tone: "success" | "warning" | "info" | "neutral" = "info";
          if (statusUpper === "PROCESSED") tone = "success";
          else if (statusUpper === "DUPLICATE" || statusUpper === "RECEIVED") tone = "neutral";
          else if (
            statusUpper === "EXHAUSTED" ||
            statusUpper === "FAILED" ||
            statusUpper === "REQUIRES_RECONCILIATION" ||
            statusUpper === "RETRY_SCHEDULED" ||
            statusUpper === "PROCESSING"
          ) {
            tone = "warning";
          }

          return (
            <div className="flex flex-col gap-0.5 py-1 leading-tight">
              <div className="flex items-center gap-1.5">
                <Badge tone={tone} className="w-fit text-[11px]">
                  {getWebhookDisplayLabel(value)}
                </Badge>
                {typeof data?.webhookAttemptCount === "number" && data.webhookAttemptCount > 0 && (
                  <span className="font-mono text-[10px] text-ink-600">
                    ({data.webhookAttemptCount} {data.webhookAttemptCount === 1 ? "try" : "tries"})
                  </span>
                )}
              </div>
              {data?.webhookEventType && (
                <span className="truncate font-mono text-[10px] text-ink-500">
                  {data.webhookEventType}
                </span>
              )}
              {data?.webhookErrorDetails && (
                <span
                  className="truncate font-mono text-[10px] text-rose-700"
                  title={data.webhookErrorDetails}
                >
                  {data.webhookErrorDetails}
                </span>
              )}
              {!data?.webhookErrorDetails && data?.webhookNextAttemptAt && (
                <span className="text-[10px] text-amber-700">
                  Next: {dateFormatter.format(new Date(data.webhookNextAttemptAt))}
                </span>
              )}
            </div>
          );
        },
      },
      {
        field: "captureId",
        headerName: "Capture Ref & Updated",
        minWidth: 165,
        filter: "agTextColumnFilter",
        cellRenderer: ({ value, data }: { value?: string | null; data?: PaymentOperationRow }) => {
          const updatedStr = data?.updatedAt ? dateFormatter.format(new Date(data.updatedAt)) : "—";
          return (
            <div className="flex flex-col py-1 leading-tight">
              <span className="font-mono text-[11px] text-ink-800">{value || "—"}</span>
              <span className="text-[10px] text-ink-500">{updatedStr}</span>
            </div>
          );
        },
      },
      {
        headerName: "Actions",
        minWidth: 175,
        pinned: "right",
        sortable: false,
        filter: false,
        cellRenderer: ({ data }: { data?: PaymentOperationRow }) => {
          if (!data) return null;
          const hasOwnerAuth = Boolean(isOwner || data.isOwner);
          const needsAttention =
            data.status !== "COMPLETED" &&
            (data.status === "RECONCILIATION_REQUIRED" ||
              data.hasExpiredLease ||
              data.status === "ORDER_CREATED" ||
              data.status === "BUYER_APPROVED" ||
              data.status === "ORDER_CREATING" ||
              data.status === "CAPTURING" ||
              Boolean(data.webhookIsExhausted) ||
              data.webhookStatus === "FAILED" ||
              data.webhookStatus === "REQUIRES_RECONCILIATION");

          return (
            <div className="flex items-center gap-1.5 py-1">
              <Button
                variant="secondary"
                className="h-7 px-2 text-xs font-medium"
                onClick={() => openModal(data, "inspect")}
                aria-label={`Inspect payment ${data.reference}`}
              >
                <Eye className="mr-1 h-3 w-3" />
                Inspect
              </Button>
              {hasOwnerAuth && needsAttention && (
                <Button
                  variant="primary"
                  className="h-7 px-2 text-xs font-medium"
                  onClick={() => openModal(data, "recover")}
                  aria-label={`Recover payment ${data.reference}`}
                >
                  <Wrench className="mr-1 h-3 w-3" />
                  Recover
                </Button>
              )}
            </div>
          );
        },
      },
    ],
    [isOwner, openModal]
  );

  const actionRequiredCount = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.status === "RECONCILIATION_REQUIRED" ||
          r.hasExpiredLease ||
          Boolean(r.webhookIsExhausted) ||
          Boolean(r.hasInconsistency)
      ).length,
    [rows]
  );

  return (
    <div className="space-y-4">
      {/* Status Tabs & Search Toolbar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5 rounded-xl bg-ink-100/70 p-1">
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "ALL"
                ? "bg-white text-ink-950 shadow-sm"
                : "text-ink-600 hover:text-ink-900"
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
            Needs Action ({actionRequiredCount})
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "IN_FLIGHT"
                ? "bg-white text-ink-950 shadow-sm"
                : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("IN_FLIGHT")}
          >
            In-Flight (
            {
              rows.filter((r) =>
                [
                  "ORDER_CREATING",
                  "ORDER_CREATED",
                  "BUYER_APPROVED",
                  "CAPTURING",
                  "RECONCILING",
                ].includes(r.status)
              ).length
            }
            )
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "COMPLETED"
                ? "bg-white text-ink-950 shadow-sm"
                : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("COMPLETED")}
          >
            Captured ({rows.filter((r) => r.status === "COMPLETED").length})
          </button>
          <button
            type="button"
            className={`rounded-lg px-3 py-1 text-xs font-semibold transition-colors ${
              filterTab === "CANCELLED"
                ? "bg-white text-ink-950 shadow-sm"
                : "text-ink-600 hover:text-ink-900"
            }`}
            onClick={() => setFilterTab("CANCELLED")}
          >
            Cancelled / Failed (
            {rows.filter((r) => r.status === "CANCELLED" || r.status === "FAILED").length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-ink-400" />
            <input
              type="text"
              placeholder="Search order ID, project, capture, event..."
              aria-label="Search payments"
              value={searchQuery}
              onChange={handleSearchChange}
              className="h-9 w-64 rounded-xl border border-ink-200 bg-white pl-8 pr-3 text-xs text-ink-900 focus:border-teal-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
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

      {/* Multi-Dimensional Operational Filters */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-ink-100 bg-ink-50/60 p-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="font-semibold text-ink-600">Payment Mode</span>
          <select
            aria-label="Filter by payment mode"
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value as "ALL" | "PLATFORM" | "MERCHANT")}
            className="h-8 rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900"
          >
            <option value="ALL">All Modes</option>
            <option value="PLATFORM">PLATFORM</option>
            <option value="MERCHANT">MERCHANT</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-ink-600">Currency</span>
          <select
            aria-label="Filter by currency"
            value={currencyFilter}
            onChange={(e) => setCurrencyFilter(e.target.value)}
            className="h-8 rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900"
          >
            <option value="ALL">All Currencies</option>
            {distinctCurrencies.map((cur) => (
              <option key={cur} value={cur}>
                {cur}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-ink-600">Seller / Payee</span>
          <select
            aria-label="Filter by seller or payee"
            value={payeeFilter}
            onChange={(e) => setPayeeFilter(e.target.value)}
            className="h-8 max-w-[200px] rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900"
          >
            <option value="ALL">All Sellers / Payees</option>
            {distinctPayees.map((payee) => (
              <option key={payee} value={payee}>
                {payee}
              </option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-ink-600">Webhook State</span>
          <select
            aria-label="Filter by webhook state"
            value={webhookFilter}
            onChange={(e) => setWebhookFilter(e.target.value)}
            className="h-8 rounded-lg border border-ink-200 bg-white px-2.5 text-xs text-ink-900"
          >
            <option value="ALL">All Webhook States</option>
            <option value="EXHAUSTED">Attempts Exhausted</option>
            <option value="RETRY_SCHEDULED">Retry Scheduled</option>
            <option value="REQUIRES_RECONCILIATION">Requires Reconciliation</option>
            <option value="FAILED">Failed</option>
            <option value="PROCESSED">Processed</option>
            <option value="VERIFIED">Verified</option>
            <option value="RECEIVED">Received</option>
            <option value="NONE">No Webhook</option>
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-ink-600">Created From</span>
          <input
            type="date"
            aria-label="Filter from date"
            value={dateFrom}
            onChange={(e) => setDateFrom(e.target.value)}
            className="h-8 rounded-lg border border-ink-200 bg-white px-2 text-xs text-ink-900"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="font-semibold text-ink-600">Created To</span>
          <input
            type="date"
            aria-label="Filter to date"
            value={dateTo}
            onChange={(e) => setDateTo(e.target.value)}
            className="h-8 rounded-lg border border-ink-200 bg-white px-2 text-xs text-ink-900"
          />
        </label>

        {(hasAdvancedFilters || filterTab !== "ALL") && (
          <Button
            variant="secondary"
            className="h-8 px-2.5 text-xs"
            onClick={resetAllFilters}
          >
            Reset Filters
          </Button>
        )}
      </div>

      {/* Main Grid View */}
      {filteredRows.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-ink-200 bg-ink-50/50 py-16 text-center">
          <HelpCircle className="h-10 w-10 text-ink-400" />
          <h3 className="mt-3 text-sm font-semibold text-ink-900">
            No payment operations records found
          </h3>
          <p className="mt-1 max-w-sm text-xs text-ink-600">
            {filterTab !== "ALL" || hasAdvancedFilters
              ? "No records match the selected filter criteria."
              : "Payment intents and ledger transactions will appear here once agreements are signed and portal checkout is initiated."}
          </p>
          {(filterTab !== "ALL" || hasAdvancedFilters) && (
            <Button
              variant="secondary"
              className="mt-4 text-xs"
              onClick={resetAllFilters}
            >
              Reset Filter
            </Button>
          )}
        </div>
      ) : (
        <div
          aria-label="Payment Operations transaction table"
          className="payroost-grid ag-theme-quartz h-[540px] w-full overflow-hidden rounded-xl border border-ink-100"
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

      {/* Correlated Payment Investigation & Explicit Confirmation Recovery Modal */}
      <PaymentInvestigationModal
        row={selectedRow}
        open={isModalOpen}
        isOwner={isOwner}
        initialView={modalInitialView}
        onClose={() => setIsModalOpen(false)}
        onRecovered={() => router.refresh()}
      />
    </div>
  );
}
