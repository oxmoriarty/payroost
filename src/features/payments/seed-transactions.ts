export type PaymentOperationRow = {
  id: string;
  reference: string;
  projectName: string;
  clientName: string;
  freelancerName: string;
  amountMinor: number;
  currency: string;
  status: "DEVELOPMENT_RECORD" | "PENDING";
  transactionDate: string;
};

export const developmentTransactions: PaymentOperationRow[] = [
  { id: "dev-001", reference: "DEV-9M3Q-A72K", projectName: "E-commerce Website", clientName: "Jordan Lee", freelancerName: "Alex Morgan", amountMinor: 40000, currency: "USD", status: "DEVELOPMENT_RECORD", transactionDate: "2026-10-29T09:30:00.000Z" },
  { id: "dev-002", reference: "DEV-5R8L-B14P", projectName: "E-commerce Website", clientName: "Jordan Lee", freelancerName: "Alex Morgan", amountMinor: 60000, currency: "USD", status: "PENDING", transactionDate: "2026-10-31T13:15:00.000Z" },
  { id: "dev-003", reference: "DEV-2H6V-C93T", projectName: "Brand refresh", clientName: "Nia Okoro", freelancerName: "Alex Morgan", amountMinor: 25000, currency: "USD", status: "DEVELOPMENT_RECORD", transactionDate: "2026-11-01T10:05:00.000Z" },
];
