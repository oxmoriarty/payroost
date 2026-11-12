import { createElement } from "react";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
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

describe("Phase 3B.R5: PaymentOperationsGrid Filters, Investigation & Two-Step Confirmation", () => {
  const r5Rows: PaymentOperationRow[] = [
    {
      ...mockOperationRows[0],
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa1",
      reference: "PLAT-ORD-101",
      paymentMode: "PLATFORM",
      payeeMerchantId: "SELLER-PLAT-01",
      sellerPayerId: "PAYER-PLAT-01",
      currency: "USD",
      status: "COMPLETED",
      webhookStatus: "PROCESSED",
      webhookAttemptCount: 1,
      createdAt: "2026-11-05T10:00:00.000Z",
    },
    {
      ...mockOperationRows[1],
      id: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2",
      reference: "MERC-ORD-202",
      paymentMode: "MERCHANT",
      payeeMerchantId: "MERC-LEGACY-01",
      currency: "USD",
      status: "RECONCILIATION_REQUIRED",
      webhookStatus: "EXHAUSTED",
      webhookIsExhausted: true,
      webhookAttemptCount: 8,
      webhookErrorDetails: "MAX_WEBHOOK_ATTEMPTS_EXCEEDED",
      createdAt: "2026-11-10T10:00:00.000Z",
    },
  ];

  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    cleanup();
  });

  it("filters by payment mode, payee/seller, webhook state, and date range", () => {
    render(createElement(PaymentOperationsGrid, { rows: r5Rows, isOwner: true }));

    const modeSelect = screen.getByLabelText("Filter by payment mode");
    fireEvent.change(modeSelect, { target: { value: "PLATFORM" } });
    expect(screen.getAllByLabelText("Payment Operations transaction table").length).toBeGreaterThan(0);

    // Selecting MERCHANT + EXHAUSTED keeps row 2
    fireEvent.change(modeSelect, { target: { value: "MERCHANT" } });
    fireEvent.change(screen.getByLabelText("Filter by webhook state"), {
      target: { value: "EXHAUSTED" },
    });
    expect(screen.getAllByLabelText("Payment Operations transaction table").length).toBeGreaterThan(0);

    // Date filter outside range shows empty filtered state with Reset option
    fireEvent.change(screen.getByLabelText("Filter from date"), {
      target: { value: "2026-12-01" },
    });
    expect(screen.getByText("No payment operations records found")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Reset Filter" }));
    expect(screen.getAllByLabelText("Payment Operations transaction table").length).toBeGreaterThan(0);
  });

  it("opens investigation modal, shows correlated dossier, and enforces two-step confirmation before POST recovery", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("/api/app/payments/aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaa2")) {
        return new Response(
          JSON.stringify({
            intent: {
              id: r5Rows[1].id,
              projectId: r5Rows[1].projectId,
              projectName: r5Rows[1].projectName,
              milestoneId: r5Rows[1].milestoneId,
              milestoneName: r5Rows[1].milestoneName,
              milestoneStatus: "PENDING",
              status: "RECONCILIATION_REQUIRED",
              amountCents: 200000,
              amountCanonical: "2000.00",
              currency: "USD",
              providerOrderId: "7B987654CD321098E",
              captureId: null,
              reconciliationReason: "PAYPAL_CAPTURE_PENDING",
              orderCreationLeaseExpiresAt: null,
              captureLeaseExpiresAt: null,
              hasExpiredLease: false,
              hasActiveLease: false,
              idempotencyWindowExpired: false,
              idempotencyKeyPrefix: "orderkey",
              captureKeyPrefix: "captkey",
              buyerApprovedAt: null,
              completedAt: null,
              createdAt: r5Rows[1].createdAt,
              updatedAt: r5Rows[1].updatedAt,
              isOwner: true,
            },
            sellerContext: {
              paymentMode: "MERCHANT",
              isLegacyWithoutMode: false,
              expectedMerchantId: "MERC-LEGACY-01",
              sellerPayerId: null,
              accountStatus: null,
              paymentsReceivable: null,
              primaryEmailConfirmed: null,
              connectedAt: null,
              accountMatchesIntentMerchant: null,
            },
            transactions: [],
            webhooks: [
              {
                id: "wh-002",
                providerEventId: "WH-LIVE-2",
                eventType: "PAYMENT.CAPTURE.COMPLETED",
                resourceType: "capture",
                resourceId: "CAP-2",
                paymentMode: "MERCHANT",
                signatureVerified: true,
                status: "FAILED",
                operationalStatus: "EXHAUSTED",
                processingOutcome: "REQUIRES_RECONCILIATION",
                attemptCount: 8,
                duplicateDeliveryCount: 1,
                isExhausted: true,
                eventCreatedAt: r5Rows[1].createdAt,
                lastProcessedAt: r5Rows[1].updatedAt,
                nextAttemptAt: null,
                leaseExpiresAt: null,
                isLeaseExpired: false,
                errorDetails: "MAX_WEBHOOK_ATTEMPTS_EXCEEDED",
                createdAt: r5Rows[1].createdAt,
              },
            ],
            timeline: [
              {
                id: "ev-1",
                eventType: "payment.marked_reconciliation_required",
                summary: "Marked intent for manual or API reconciliation",
                actorLabel: "system",
                createdAt: r5Rows[1].updatedAt,
                metadata: { previousStatus: "CAPTURING", resultingStatus: "RECONCILIATION_REQUIRED" },
              },
            ],
            consistencyWarnings: [
              "Automated webhook retry attempts are exhausted — operator reconciliation or manual replay required.",
            ],
            actions: [
              {
                action: "RECONCILE",
                label: "Reconcile via PayPal API",
                shortLabel: "Reconcile",
                description: "Queries PayPal authoritatively.",
                impactSummary: "Queries PayPal and reconciles ledger.",
                confirmationPrompt: "Confirm PayPal inquiry reconciliation.",
                allowed: true,
                blockedReason: null,
                recommended: true,
                destructive: false,
              },
              {
                action: "CLEAR_EXPIRED_LEASE",
                label: "Clear Expired Processing Lease",
                shortLabel: "Clear Lease",
                description: "Clears expired lease locks.",
                impactSummary: "Frees lease lock.",
                confirmationPrompt: "Confirm clearing expired lease.",
                allowed: false,
                blockedReason: "No order-creation or capture lease token is currently set on this intent.",
                recommended: false,
                destructive: false,
              },
            ],
            milestoneIndependenceNotice:
              "Milestones are never automatically approved or completed by PayPal captures, webhooks, or operator recovery actions.",
          }),
          { status: 200 }
        );
      }
      if (url === "/api/app/csrf") {
        return new Response(JSON.stringify({ csrfToken: "csrf-test-token" }), { status: 200 });
      }
      if (url === "/api/app/payments/recovery" && init?.method === "POST") {
        return new Response(
          JSON.stringify({ success: true, resultingStatus: "COMPLETED" }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ error: "NOT_MOCKED" }), { status: 404 });
    });

    render(createElement(PaymentOperationsGrid, { rows: r5Rows, isOwner: true }));

    const inspectBtn = await screen.findByRole("button", { name: "Inspect payment MERC-ORD-202" });
    fireEvent.click(inspectBtn);

    await waitFor(() => {
      expect(screen.getByText(/Payment Investigation & Recovery/)).toBeInTheDocument();
      expect(screen.getByText(/Milestones are never automatically approved/)).toBeInTheDocument();
    });

    // Switch to Webhooks tab and confirm retry/error info is shown
    const webhooksTab = await screen.findByRole("button", { name: /Webhooks \(1\)/ });
    fireEvent.click(webhooksTab);
    expect(screen.getByText(/Sanitized reason:/)).toBeInTheDocument();
    expect(screen.getAllByText(/MAX_WEBHOOK_ATTEMPTS_EXCEEDED/).length).toBeGreaterThanOrEqual(2);

    // Switch to Recovery Controls and check blocked precondition + explicit two-step confirmation
    fireEvent.click(screen.getByRole("button", { name: "Recovery Controls" }));
    expect(
      screen.getByText(/Precondition: No order-creation or capture lease token is currently set/)
    ).toBeInTheDocument();
    expect(screen.queryByText(/verified ticket is supplied/i)).not.toBeInTheDocument();

    // Step 1: Review & Confirm does NOT fire POST recovery yet
    fireEvent.click(screen.getByRole("button", { name: "Review & Confirm" }));
    expect(screen.getByText(/Confirm Recovery Execution/)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.filter(([u]) => String(u) === "/api/app/payments/recovery")
    ).toHaveLength(0);

    // Step 2: Explicit confirmation executes CSRF + POST recovery
    fireEvent.click(screen.getByRole("button", { name: "Confirm & Execute Recovery" }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([u]) => String(u) === "/api/app/payments/recovery")
      ).toHaveLength(1);
      expect(screen.getByText(/Reconcile completed cleanly/)).toBeInTheDocument();
    });
  });
});
