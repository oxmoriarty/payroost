import { createElement } from "react";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { describe, expect, it, vi, afterEach } from "vitest";
import { PaymentOperationsGrid } from "@/features/payments/payment-operations-grid";
import { developmentTransactions } from "@/features/payments/seed-transactions";
import type { PaymentOperationRow } from "@/features/payments/operations-data";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

const mockOperationRows: PaymentOperationRow[] = [
  {
    id: "99999999-9999-9999-9999-999999999991",
    reference: "PAYPAL-ORD-001",
    projectId: "11111111-1111-1111-1111-111111111111",
    projectName: "Website Redesign",
    clientName: "Acme Corp",
    milestoneId: "22222222-2222-2222-2222-222222222221",
    milestoneName: "Milestone 1: Design Phase",
    amountCents: 150000,
    amountCanonical: "1500.00",
    currency: "USD",
    status: "COMPLETED",
    providerOrderId: "8A123456BC789012D",
    captureId: "2XY12345AB678901C",
    reconciliationReason: null,
    webhookStatus: "PROCESSED",
    webhookEventId: "wh-001",
    hasExpiredLease: false,
    isOwner: true,
    createdAt: "2026-11-09T10:00:00.000Z",
    updatedAt: "2026-11-09T10:05:00.000Z",
  },
  {
    id: "99999999-9999-9999-9999-999999999992",
    reference: "PAYPAL-ORD-002",
    projectId: "11111111-1111-1111-1111-111111111111",
    projectName: "Website Redesign",
    clientName: "Acme Corp",
    milestoneId: "22222222-2222-2222-2222-222222222222",
    milestoneName: "Milestone 2: Frontend",
    amountCents: 200000,
    amountCanonical: "2000.00",
    currency: "USD",
    status: "RECONCILIATION_REQUIRED",
    providerOrderId: "7B987654CD321098E",
    captureId: null,
    reconciliationReason: "PAYPAL_CAPTURE_PENDING",
    webhookStatus: "RECEIVED",
    webhookEventId: "wh-002",
    hasExpiredLease: false,
    isOwner: true,
    createdAt: "2026-11-09T12:00:00.000Z",
    updatedAt: "2026-11-09T12:10:00.000Z",
  },
  {
    id: "99999999-9999-9999-9999-999999999993",
    reference: "PAYPAL-ORD-003",
    projectId: "11111111-1111-1111-1111-111111111111",
    projectName: "Website Redesign",
    clientName: "Acme Corp",
    milestoneId: "22222222-2222-2222-2222-222222222223",
    milestoneName: "Milestone 3: Backend API",
    amountCents: 250000,
    amountCanonical: "2500.00",
    currency: "USD",
    status: "CAPTURING",
    providerOrderId: "6C555555DE111111F",
    captureId: null,
    reconciliationReason: null,
    webhookStatus: null,
    webhookEventId: null,
    hasExpiredLease: true,
    isOwner: true,
    createdAt: "2026-11-09T14:00:00.000Z",
    updatedAt: "2026-11-09T14:01:00.000Z",
  },
];

describe("PaymentOperationsGrid", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a labelled transaction table container with seed rows", () => {
    render(createElement(PaymentOperationsGrid, { rows: developmentTransactions as unknown as PaymentOperationRow[] }));
    expect(screen.getAllByLabelText("Payment Operations transaction table").length).toBeGreaterThan(0);
  });

  it("renders with live database rows and filter tabs", () => {
    render(createElement(PaymentOperationsGrid, { rows: mockOperationRows, isOwner: true }));
    expect(screen.getAllByLabelText("Payment Operations transaction table").length).toBeGreaterThan(0);
    expect(screen.getByText(/All \(3\)/)).toBeInTheDocument();
    expect(screen.getByText(/Needs Action \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/In-Flight \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Captured \(1\)/)).toBeInTheDocument();
  });

  it("renders empty state cleanly when no rows match", () => {
    render(createElement(PaymentOperationsGrid, { rows: [] }));
    expect(screen.getByText("No payment operations records found")).toBeInTheDocument();
  });

  it("switches filter tab and updates view", () => {
    render(createElement(PaymentOperationsGrid, { rows: mockOperationRows, isOwner: true }));
    const needsActionTab = screen.getByText(/Needs Action \(2\)/);
    fireEvent.click(needsActionTab);
    expect(screen.getAllByLabelText("Payment Operations transaction table").length).toBeGreaterThan(0);
  });
});
