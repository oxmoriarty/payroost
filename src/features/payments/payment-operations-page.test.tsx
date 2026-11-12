import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
const mockGetUser = vi.fn();
const mockIntentsOrder = vi.fn();
const mockTxIn = vi.fn();
const mockCookieSet = vi.fn(() => {
  throw new Error("Cookies can only be modified in a Server Action or Route Handler");
});

vi.mock("server-only", () => ({}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mockRedirect(url),
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    has: () => false,
    get: () => undefined,
    set: mockCookieSet,
  })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({
    auth: { getUser: mockGetUser },
    from: vi.fn((table: string) => {
      if (table === "payment_intents") {
        return {
          select: vi.fn(() => ({
            order: mockIntentsOrder,
          })),
        };
      }
      if (table === "payment_transactions") {
        return {
          select: vi.fn(() => ({
            in: mockTxIn,
          })),
        };
      }
      throw new Error(`Unexpected table queried: ${table}`);
    }),
  })),
}));

vi.mock("@/lib/supabase/service", () => ({
  createServiceClient: vi.fn(() => {
    throw new Error("SUPABASE_SERVICE_ROLE_KEY not configured in unit test");
  }),
}));

vi.mock("@/features/payments/payment-operations-grid", () => ({
  PaymentOperationsGrid: ({
    rows,
    isOwner,
  }: {
    rows: Array<{ id: string; projectName: string }>;
    isOwner?: boolean;
  }) => (
    <div data-testid="payment-operations-grid" data-owner={String(Boolean(isOwner))}>
      {rows.length === 0 ? "No payment records" : `${rows.length} payment records`}
    </div>
  ),
}));

import PaymentOperationsPage from "@/app/(app)/app/payments/page";
import { getPaymentOperationsData } from "@/features/payments/operations-data";

describe("Payment Operations Page and Data Loader", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUser.mockResolvedValue({
      data: { user: { id: "user-owner-1", email: "owner@payroost.dev" } },
      error: null,
    });
    mockIntentsOrder.mockResolvedValue({
      data: [],
      error: null,
    });
    mockTxIn.mockResolvedValue({
      data: [],
      error: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders PaymentOperationsPage cleanly without modifying cookies when payment and webhook records are empty", async () => {
    const pageElement = await PaymentOperationsPage();
    render(pageElement);

    expect(mockCookieSet).not.toHaveBeenCalled();
    expect(screen.getByText("Payment Operations & Recovery")).toBeInTheDocument();
    expect(screen.getByTestId("payment-operations-grid")).toHaveTextContent("No payment records");
  });

  it("redirects to /login when user session is unauthorized", async () => {
    mockGetUser.mockResolvedValueOnce({
      data: { user: null },
      error: { message: "Auth session missing" },
    });

    await expect(PaymentOperationsPage()).rejects.toThrow("NEXT_REDIRECT:/login");
    expect(mockCookieSet).not.toHaveBeenCalled();
  });

  it("displays safe error message on database permission errors without throwing unhandled page exception", async () => {
    mockIntentsOrder.mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "permission denied for table payment_intents" },
    });

    const pageElement = await PaymentOperationsPage();
    render(pageElement);

    expect(screen.getByText(/Error loading payment records:/i)).toBeInTheDocument();
    expect(screen.getByText(/Database permissions for payment records are missing/i)).toBeInTheDocument();
  });

  it("handles array-wrapped relations, incomplete optional metadata, invalid dates, and missing service role gracefully", async () => {
    mockIntentsOrder.mockResolvedValueOnce({
      data: [
        {
          id: "intent-edge-1",
          project_id: "proj-1",
          milestone_id: "ms-1",
          status: "COMPLETED",
          expected_amount_cents: null,
          expected_amount_canonical: null,
          expected_currency: null,
          expected_merchant_id: null,
          canonical_payload_json: null,
          provider_order_id: null,
          order_creation_lease_expires_at: "not-a-valid-date",
          capture_lease_expires_at: null,
          reconciliation_reason: null,
          buyer_approved_at: null,
          completed_at: null,
          created_at: null,
          updated_at: null,
          projects: [
            {
              id: "proj-1",
              title: "Array Joined Project",
              client_name: null,
              client_email: null,
              owner_id: "user-owner-1",
            },
          ],
          milestones: [
            {
              id: "ms-1",
              title: null,
              status: "ACCEPTED",
            },
          ],
        },
      ],
      error: null,
    });

    const result = await getPaymentOperationsData();

    expect(result.error).toBeUndefined();
    expect(result.isOwner).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      id: "intent-edge-1",
      projectName: "Array Joined Project",
      clientName: "—",
      milestoneName: "Milestone",
      amountCents: 0,
      amountCanonical: "0.00",
      currency: "USD",
      hasExpiredLease: false,
      webhookStatus: null,
    });
    expect(result.summary.totalVolumeCents).toBe(0);
    expect(result.summary.confirmedCaptures).toBe(1);
  });
});
