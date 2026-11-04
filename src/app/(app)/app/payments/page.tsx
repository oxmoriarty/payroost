import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { PaymentOperationsGrid } from "@/features/payments/payment-operations-grid";
import { developmentTransactions } from "@/features/payments/seed-transactions";

export default function PaymentOperationsPage() {
  return <><div className="flex flex-wrap items-end justify-between gap-4"><div><p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Payment operations</p><h1 className="mt-2 font-display text-4xl text-ink-950">Payment records, not payment controls.</h1><p className="mt-2 max-w-2xl text-ink-700">A read-only operational view. This foundation contains fictional development seed data and cannot create, capture, refund, or alter any transaction.</p></div><Badge tone="warning">Development data only</Badge></div><div className="mt-8 grid gap-4 sm:grid-cols-3"><Card className="p-5"><p className="text-sm font-semibold text-ink-700">Displayed records</p><p className="mt-3 font-display text-3xl">{developmentTransactions.length}</p></Card><Card className="p-5"><p className="text-sm font-semibold text-ink-700">Confirmed captures</p><p className="mt-3 font-display text-3xl">0</p></Card><Card className="p-5"><p className="text-sm font-semibold text-ink-700">Financial actions</p><p className="mt-3 font-display text-3xl">0</p></Card></div><Card className="mt-6 overflow-hidden p-3 sm:p-5"><PaymentOperationsGrid rows={developmentTransactions} /></Card></>;
}
