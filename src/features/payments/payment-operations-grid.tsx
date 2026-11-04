"use client";

import { useMemo } from "react";
import { AllCommunityModule, type ColDef } from "ag-grid-community";
import { AgGridProvider, AgGridReact } from "ag-grid-react";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils";
import type { PaymentOperationRow } from "@/features/payments/seed-transactions";

const dateFormatter = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });

export function PaymentOperationsGrid({ rows }: { rows: PaymentOperationRow[] }) {
  const columns = useMemo<ColDef<PaymentOperationRow>[]>(() => [
    { field: "reference", headerName: "Transaction reference", minWidth: 175, filter: "agTextColumnFilter", cellClass: "font-semibold text-ink-800" },
    { field: "projectName", headerName: "Project", minWidth: 180, filter: "agTextColumnFilter" },
    { field: "clientName", headerName: "Client", minWidth: 145, filter: "agTextColumnFilter" },
    { field: "freelancerName", headerName: "Freelancer", minWidth: 160, filter: "agTextColumnFilter" },
    { field: "amountMinor", headerName: "Amount", minWidth: 130, type: "numericColumn", valueFormatter: ({ value, data }) => data ? formatMoney(value as number, data.currency) : "—" },
    { field: "currency", headerName: "Currency", minWidth: 105, filter: "agTextColumnFilter" },
    { field: "status", headerName: "Status", minWidth: 155, filter: "agTextColumnFilter", cellRenderer: ({ value }: { value: PaymentOperationRow["status"] }) => <Badge tone={value === "PENDING" ? "warning" : "info"}>{value === "PENDING" ? "Pending (seed)" : "Development seed"}</Badge> },
    { field: "transactionDate", headerName: "Transaction date", minWidth: 175, valueFormatter: ({ value }) => value ? dateFormatter.format(new Date(value as string)) : "—" },
  ], []);

  return <div aria-label="Payment Operations transaction table" className="payroost-grid ag-theme-quartz h-[460px] w-full overflow-hidden rounded-xl border border-ink-100"><AgGridProvider modules={[AllCommunityModule]}><AgGridReact<PaymentOperationRow> columnDefs={columns} defaultColDef={{ sortable: true, filter: true, resizable: true }} getRowId={({ data }) => data.id} pagination paginationPageSize={10} paginationPageSizeSelector={[10, 25, 50]} rowData={rows} suppressCellFocus={false} /></AgGridProvider></div>;
}
