import { redirect } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PaymentOperationsGrid } from "@/features/payments/payment-operations-grid";
import { getPaymentOperationsData } from "@/features/payments/operations-data";
import { formatMoney } from "@/lib/utils";

export const dynamic = "force-dynamic";

export default async function PaymentOperationsPage() {
  // Load real server-side payment records and metrics (operator CSRF cookie is initialized on the client via GET /api/app/csrf).
  const { rows, summary, isOwner, error } = await getPaymentOperationsData();

  if (error === "UNAUTHORIZED") {
    redirect("/login");
  }

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">
            Payments Operations
          </p>
          <h1 className="mt-2 font-display text-3xl text-ink-950 sm:text-4xl">
            Financial ledger
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {summary.reconciliationRequired > 0 && (
            <Badge tone="warning" className="bg-rose-50 text-rose-800 ring-rose-300">
              {summary.reconciliationRequired} Requires Attention
            </Badge>
          )}
          {isOwner && (
            <Badge tone="success">Operator Authorized</Badge>
          )}
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:mt-8 sm:gap-4 lg:grid-cols-4">
        <Card className="pr-interactive-card p-4 sm:p-5 hover:border-ink-200">
          <p className="text-xs font-semibold text-ink-700 sm:text-sm">Total Intents</p>
          <p className="mt-2 font-display text-2xl text-ink-950 sm:mt-3 sm:text-3xl">{summary.totalRecords}</p>
          <p className="mt-1 text-[11px] text-ink-500 sm:text-xs">
            Platform: {summary.platformCount ?? 0} • Merchant: {summary.merchantCount ?? 0}
          </p>
        </Card>
        <Card className="pr-interactive-card p-4 sm:p-5 hover:border-ink-200">
          <p className="text-xs font-semibold text-ink-700 sm:text-sm">Confirmed Captures</p>
          <p className="mt-2 font-display text-2xl text-emerald-700 sm:mt-3 sm:text-3xl">
            {summary.confirmedCaptures}
          </p>
          <p className="mt-1 text-[11px] text-ink-500 sm:text-xs">
            Volume: {formatMoney(summary.totalVolumeCents, "USD")}
          </p>
        </Card>
        <Card className="pr-interactive-card p-4 sm:p-5 hover:border-ink-200">
          <p className="text-xs font-semibold text-ink-700 sm:text-sm">Needs Reconciliation</p>
          <p
            className={`mt-2 font-display text-2xl sm:mt-3 sm:text-3xl ${
              summary.reconciliationRequired > 0 ? "text-rose-600 font-bold" : "text-ink-950"
            }`}
          >
            {summary.reconciliationRequired}
          </p>
          <p className="mt-1 text-[11px] text-ink-500 sm:text-xs">
            Expired leases: {summary.expiredLeases ?? 0}
          </p>
        </Card>
        <Card className="pr-interactive-card p-4 sm:p-5 hover:border-ink-200">
          <p className="text-xs font-semibold text-ink-700 sm:text-sm">In-Flight / Pending</p>
          <p className="mt-2 font-display text-2xl text-amber-600 sm:mt-3 sm:text-3xl">{summary.inFlight}</p>
          <p className="mt-1 text-[11px] text-ink-500 sm:text-xs">Active checkout or capture</p>
        </Card>
      </div>

      {/* Grid Container */}
      <Card className="mt-6 overflow-hidden p-3 sm:p-5">
        {error ? (
          <div className="rounded-xl border border-rose-200 bg-rose-50 p-4 text-xs text-rose-800">
            <span className="font-bold">Error loading payment records:</span> {error}
          </div>
        ) : (
          <PaymentOperationsGrid rows={rows} isOwner={isOwner} />
        )}
      </Card>
    </>
  );
}
