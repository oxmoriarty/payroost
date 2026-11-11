import { cookies } from "next/headers";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PaymentOperationsGrid } from "@/features/payments/payment-operations-grid";
import { getPaymentOperationsData } from "@/features/payments/operations-data";
import { formatMoney } from "@/lib/utils";
import {
  generateOperatorCsrfSecret,
  getOperatorCsrfCookieName,
  getOperatorCsrfCookieOptions,
} from "@/lib/security/operator-csrf";

export default async function PaymentOperationsPage() {
  // Ensure operator CSRF cookie is initialized for client mutations
  const cookieStore = await cookies();
  const csrfCookieName = getOperatorCsrfCookieName();
  if (!cookieStore.has(csrfCookieName)) {
    const csrfToken = generateOperatorCsrfSecret();
    cookieStore.set(csrfCookieName, csrfToken, getOperatorCsrfCookieOptions());
  }

  // Load real server-side payment records and metrics
  const { rows, summary, isOwner, error } = await getPaymentOperationsData();

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">
            Payment Operations & Recovery
          </p>
          <h1 className="mt-2 font-display text-4xl text-ink-950">
            Financial ledger, recovery, and observability.
          </h1>
          <p className="mt-2 max-w-2xl text-ink-700">
            Authoritative operational view of PayPal Sandbox payments. Monitor active transactions,
            investigate ambiguous states, and execute audited reconciliation without compromising ledger immutability.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {summary.reconciliationRequired > 0 && (
            <Badge tone="warning" className="bg-rose-50 text-rose-800 ring-rose-300">
              {summary.reconciliationRequired} Requires Attention
            </Badge>
          )}
          <Badge tone={isOwner ? "success" : "neutral"}>
            {isOwner ? "Operator Authorized" : "Project Member (Read-Only)"}
          </Badge>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="mt-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Card className="p-5">
          <p className="text-sm font-semibold text-ink-700">Total Intents</p>
          <p className="mt-3 font-display text-3xl text-ink-950">{summary.totalRecords}</p>
          <p className="mt-1 text-xs text-ink-500">Tracked in database ledger</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-ink-700">Confirmed Captures</p>
          <p className="mt-3 font-display text-3xl text-emerald-700">
            {summary.confirmedCaptures}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Volume: {formatMoney(summary.totalVolumeCents, "USD")}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-ink-700">Needs Reconciliation</p>
          <p
            className={`mt-3 font-display text-3xl ${
              summary.reconciliationRequired > 0 ? "text-rose-600 font-bold" : "text-ink-950"
            }`}
          >
            {summary.reconciliationRequired}
          </p>
          <p className="mt-1 text-xs text-ink-500">Ambiguous or timed-out orders</p>
        </Card>
        <Card className="p-5">
          <p className="text-sm font-semibold text-ink-700">In-Flight / Pending</p>
          <p className="mt-3 font-display text-3xl text-amber-600">{summary.inFlight}</p>
          <p className="mt-1 text-xs text-ink-500">Active checkout or capture</p>
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
