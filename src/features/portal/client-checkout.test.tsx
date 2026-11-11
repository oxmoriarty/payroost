import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ClientPortalEntryView } from "./client-portal-entry-view";
import { ClientPortalWorkspaceView } from "./client-portal-workspace-view";
import { MilestoneCheckout } from "./milestone-checkout";
import type { PortalProjectData, PortalMilestone } from "./types";

/**
 * ============================================================================
 * TEST SUITE CLASSIFICATION: Mocked Component & Unit Tests (JSDOM Environment)
 * ============================================================================
 * These tests execute in a mocked React Testing Library / jsdom environment with
 * mocked global fetch and mocked window.paypal SDK interfaces.
 * They are NOT live database, PostgREST, or live PayPal Sandbox network tests.
 */

// Mock next/navigation
const mockRefresh = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: mockRefresh,
    push: vi.fn(),
  }),
}));

const mockToken = "portal-test-token-43-chars-base64url-valid_";
const mockCsrfToken = "csrf-secret-64-character-hex-string-test-value-1234567890abcdef";

const samplePayableMilestone1: PortalMilestone = {
  id: "m1111111-1111-4111-a111-111111111111",
  title: "Frontend Integration & Dashboard",
  description: "Complete responsive user interface with checkout flow.",
  deliverables: ["Dashboard UI", "Checkout component", "Unit tests"],
  amountMinor: 150000,
  currency: "USD",
  dueDate: "2026-12-01T00:00:00.000Z",
  sortOrder: 1,
  status: "APPROVED",
  isPayable: true,
  paymentStatus: "UNPAID",
};

const samplePayableMilestone2: PortalMilestone = {
  id: "m2222222-2222-4222-a222-222222222222",
  title: "API Gateway & Security",
  description: "OAuth and webhook security layer.",
  deliverables: ["Gateway config", "HMAC validator"],
  amountMinor: 250000,
  currency: "USD",
  dueDate: "2026-12-10T00:00:00.000Z",
  sortOrder: 2,
  status: "APPROVED",
  isPayable: true,
  paymentStatus: "UNPAID",
};

const samplePaidMilestone: PortalMilestone = {
  id: "m3333333-3333-4333-a333-333333333333",
  title: "Architecture & Data Modeling",
  description: "Initial database design and migrations.",
  deliverables: ["Schema design", "Seed data"],
  amountMinor: 100000,
  currency: "USD",
  dueDate: "2026-11-01T00:00:00.000Z",
  sortOrder: 0,
  status: "APPROVED",
  isPayable: false,
  paymentStatus: "PAID",
  completedCaptureId: "CAP-PAYPAL-12345",
};

const samplePendingReconMilestone: PortalMilestone = {
  id: "m4444444-4444-4444-a444-444444444444",
  title: "Backend Payment Webhooks",
  description: "Provider webhook ingestion and reconciliation.",
  deliverables: ["Webhook listener", "HMAC verification"],
  amountMinor: 200000,
  currency: "USD",
  dueDate: "2026-12-15T00:00:00.000Z",
  sortOrder: 3,
  status: "IN_PROGRESS",
  isPayable: false,
  paymentStatus: "PENDING_VERIFICATION",
};

const sampleIneligibleMilestone: PortalMilestone = {
  id: "m5555555-5555-4555-a555-555555555555",
  title: "Future Scope Expansion",
  description: "Draft phase work pending approval.",
  deliverables: ["Scoping document"],
  amountMinor: 50000,
  currency: "USD",
  dueDate: null,
  sortOrder: 4,
  status: "DRAFT",
  isPayable: false,
  paymentStatus: "UNPAID",
};

const sampleProjectData: PortalProjectData = {
  id: "p0000000-0000-4000-a000-000000000001",
  title: "Fintech Platform Modernization",
  clientName: "Jane Client",
  clientEmail: "jane@client-domain.com",
  brief: "Modernize frontend checkout and settlement rails.",
  currency: "USD",
  totalAmountMinor: 750000,
  projectStatus: "ACTIVE",
  agreementStatus: "APPROVED",
  agreementVersionNumber: 1,
  milestones: [
    samplePaidMilestone,
    samplePayableMilestone1,
    samplePayableMilestone2,
    samplePendingReconMilestone,
    sampleIneligibleMilestone,
  ],
};

describe("Phase 3B.5.1: Client Portal Entry & Authentication View", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders invitation metadata and request-OTP action", () => {
    render(
      <ClientPortalEntryView
        token={mockToken}
        projectTitle="Fintech Platform Modernization"
        expiresAt="2026-11-20T12:00:00.000Z"
      />
    );

    expect(screen.getByText("Fintech Platform Modernization")).toBeInTheDocument();
    expect(screen.getByText(/Send Verification Code/i)).toBeInTheDocument();
    expect(screen.getByText(/Protected Identity Verification/i)).toBeInTheDocument();
  });

  it("requests OTP and transitions to 6-digit confirmation code input", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        maskedEmail: "j***e@client-domain.com",
        challengeId: "c0000000-0000-4000-a000-000000000001",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ClientPortalEntryView
        token={mockToken}
        projectTitle="Fintech Platform Modernization"
        expiresAt="2026-11-20T12:00:00.000Z"
      />
    );

    fireEvent.click(screen.getByText(/Send Verification Code/i));

    await waitFor(() => {
      expect(screen.getByText(/Verification code dispatched/i)).toBeInTheDocument();
      expect(screen.getByText("j***e@client-domain.com")).toBeInTheDocument();
      expect(screen.getByPlaceholderText("000000")).toBeInTheDocument();
    });

    expect(mockFetch).toHaveBeenCalledWith(
      `/api/public/portal/${encodeURIComponent(mockToken)}/otp`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("verifies OTP code and triggers router refresh upon success", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          maskedEmail: "j***e@client-domain.com",
          challengeId: "c0000000-0000-4000-a000-000000000001",
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          projectId: "p0000000-0000-4000-a000-000000000001",
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ClientPortalEntryView
        token={mockToken}
        projectTitle="Fintech Platform Modernization"
        expiresAt="2026-11-20T12:00:00.000Z"
      />
    );

    fireEvent.click(screen.getByText(/Send Verification Code/i));

    await waitFor(() => {
      expect(screen.getByPlaceholderText("000000")).toBeInTheDocument();
    });

    const input = screen.getByPlaceholderText("000000");
    fireEvent.change(input, { target: { value: "654321" } });
    fireEvent.click(screen.getByText(/Verify & Enter Portal/i));

    await waitFor(() => {
      expect(mockRefresh).toHaveBeenCalled();
    });
  });

  it("displays rate-limit lock error when OTP requests are exhausted", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      json: async () => ({
        error: "RATE_LIMITED",
        message: "Too many requests. Please wait a few minutes before trying again.",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ClientPortalEntryView
        token={mockToken}
        projectTitle="Fintech Platform Modernization"
        expiresAt="2026-11-20T12:00:00.000Z"
      />
    );

    fireEvent.click(screen.getByText(/Send Verification Code/i));

    await waitFor(() => {
      expect(screen.getByText(/Too many requests/i)).toBeInTheDocument();
    });
  });
});

describe("Phase 3B.5.1: 20 Required Checkout & Workspace Scenarios", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  // Scenario 1: No payable milestones
  it("Scenario 1: renders workspace correctly when there are no payable milestones", () => {
    const projectWithNoPayable: PortalProjectData = {
      ...sampleProjectData,
      milestones: [samplePaidMilestone, sampleIneligibleMilestone],
    };

    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={projectWithNoPayable}
        csrfToken={mockCsrfToken}
      />
    );

    expect(screen.queryByText("Pay Milestone")).not.toBeInTheDocument();
    expect(screen.getByText("Paid")).toBeInTheDocument();
    expect(screen.getByText("Not Payable")).toBeInTheDocument();
  });

  // Scenario 2: One payable milestone
  it("Scenario 2: renders exactly one payable milestone with active pay button", () => {
    const projectWithOnePayable: PortalProjectData = {
      ...sampleProjectData,
      milestones: [samplePaidMilestone, samplePayableMilestone1],
    };

    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={projectWithOnePayable}
        csrfToken={mockCsrfToken}
      />
    );

    const payButtons = screen.getAllByText("Pay Milestone");
    expect(payButtons.length).toBe(1);
    expect(screen.getByText("Frontend Integration & Dashboard")).toBeInTheDocument();
  });

  // Scenario 3: Multiple payable milestones
  it("Scenario 3: handles multiple payable milestones and toggles active drawer correctly", () => {
    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={sampleProjectData}
        csrfToken={mockCsrfToken}
      />
    );

    const payButtons = screen.getAllByText("Pay Milestone");
    expect(payButtons.length).toBe(2);

    // Click first payable milestone
    fireEvent.click(payButtons[0]);
    expect(screen.getByText("Hide Checkout")).toBeInTheDocument();
    expect(screen.getByText(/Pay with PayPal \(\$1,500.00\)/i)).toBeInTheDocument();

    // Click second payable milestone switches active checkout
    const secondPayButton = screen.getByText("Pay Milestone");
    fireEvent.click(secondPayButton);
    expect(screen.getByText(/Pay with PayPal \(\$2,500.00\)/i)).toBeInTheDocument();
  });

  // Scenario 4: Refresh during checkout (in-progress state + cached HATEOAS approvalUrl restored)
  it("Scenario 4: restores in-progress intent and order IDs after page refresh during checkout", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-restored-111",
      providerOrderId: "ORDER-RESTORED-222",
    };

    sessionStorage.setItem(
      `payroost_paypal_approval_${mockToken}_ORDER-RESTORED-222`,
      "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-RESTORED-222"
    );

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);
    const mockRedirect = vi.fn();

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        onRedirectToPayPal={mockRedirect}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      expect(mockRedirect).toHaveBeenCalledWith(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-RESTORED-222"
      );
      expect(mockFetch).not.toHaveBeenCalled();
      expect(screen.getByText("Complete Approval on PayPal")).toBeInTheDocument();
      expect(screen.getByText("Continue to PayPal Approval")).toBeInTheDocument();
    });
  });

  // Scenario 5: Rapid double-click concurrency protection
  it("Scenario 5: guards against rapid double-clicks using synchronous isInitiatingRef", async () => {
    let callCount = 0;
    const mockFetch = vi.fn().mockImplementation(async () => {
      callCount++;
      // Artificial latency to simulate in-flight request
      await new Promise((r) => setTimeout(r, 50));
      return {
        ok: true,
        json: async () => ({
          success: true,
          paymentIntentId: "intent-single-instance",
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={samplePayableMilestone1}
        csrfToken={mockCsrfToken}
        onRedirectToPayPal={vi.fn()}
      />
    );

    const payBtn = screen.getByText(/Pay with PayPal/i);
    // Rapid double-click
    fireEvent.click(payBtn);
    fireEvent.click(payBtn);

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(callCount).toBe(1);
    });
  });

  // Scenario 6: Existing payment intent reused
  it("Scenario 6: reuses existing payment intent without creating a duplicate", async () => {
    const milestoneWithIntent: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentIntentId: "existing-intent-555",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        orderId: "ORDER-NEW-666",
        paymentIntentId: "existing-intent-555",
        approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NEW-666",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockRedirect = vi.fn();

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={milestoneWithIntent}
        csrfToken={mockCsrfToken}
        onRedirectToPayPal={mockRedirect}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      // Must not call /payments/intents
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/payments/intents"),
        expect.anything()
      );
      // Calls /payments/orders with existing intent ID
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/public/portal/${encodeURIComponent(mockToken)}/payments/orders`,
        expect.objectContaining({
          body: JSON.stringify({
            paymentIntentId: "existing-intent-555",
            milestoneId: milestoneWithIntent.id,
          }),
        })
      );
      expect(mockRedirect).toHaveBeenCalledWith(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NEW-666"
      );
    });
  });

  // Scenario 7: Existing PayPal order reused via server HATEOAS link resolution
  it("Scenario 7: reuses existing PayPal order without calling /payments/intents and redirects using HATEOAS approvalUrl", async () => {
    const milestoneWithOrder: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentIntentId: "existing-intent-777",
      providerOrderId: "ORDER-ALREADY-CREATED-888",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        orderId: "ORDER-ALREADY-CREATED-888",
        paymentIntentId: "existing-intent-777",
        approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-ALREADY-CREATED-888",
        reused: true,
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const mockRedirect = vi.fn();

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={milestoneWithOrder}
        csrfToken={mockCsrfToken}
        onRedirectToPayPal={mockRedirect}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      expect(mockFetch).not.toHaveBeenCalledWith(
        expect.stringContaining("/payments/intents"),
        expect.anything()
      );
      expect(mockRedirect).toHaveBeenCalledWith(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-ALREADY-CREATED-888"
      );
    });
  });

  // Scenario 8: Missing approval link handling & retry
  it("Scenario 8: handles missing PayPal approval link gracefully and supports retry without injecting PayPal JS SDK", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, paymentIntentId: "intent-hateoas-retry" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, orderId: "ORDER-NO-LINK" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          orderId: "ORDER-NO-LINK",
          approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NO-LINK",
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    const mockRedirect = vi.fn();

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={samplePayableMilestone1}
        csrfToken={mockCsrfToken}
        onRedirectToPayPal={mockRedirect}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      expect(
        screen.getByText(/PayPal approval link was not returned for this order. Please retry checkout/i)
      ).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Retry Checkout/i })).toBeInTheDocument();
    });

    expect(document.getElementById("paypal-sdk-script")).toBeNull();
    expect((window as unknown as { paypal?: unknown }).paypal).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: /Retry Checkout/i }));

    await waitFor(() => {
      expect(mockRedirect).toHaveBeenCalledWith(
        "https://www.sandbox.paypal.com/checkoutnow?token=ORDER-NO-LINK"
      );
    });
  });

  // Scenario 9: Buyer cancellation via cancel_url return query params
  it("Scenario 9: handles buyer cancellation return state and displays non-blocking notice", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-cancel-test",
      providerOrderId: "ORDER-CANCEL-TEST",
    };

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-cancel-test",
          paymentStatus: "cancelled",
          orderToken: "ORDER-CANCEL-TEST",
        }}
        onRedirectToPayPal={vi.fn()}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(/PayPal checkout was cancelled before payment approval. You can resume or retry when ready/i)
      ).toBeInTheDocument();
    });

    expect(mockFetch).not.toHaveBeenCalled();
  });

  // Scenario 10: Successful server-confirmed capture upon approved PayPal return redirect
  it("Scenario 10: executes server-side capture upon PayPal return approval and displays confirmed status", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-ok-123",
      providerOrderId: "ORDER-OK-456",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        status: "COMPLETED",
        captureId: "CAP-CONFIRMED-999",
        orderId: "ORDER-OK-456",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const onPaymentSuccessMock = vi.fn();

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-ok-123",
          paymentStatus: "approved",
          orderToken: "ORDER-OK-456",
        }}
        onPaymentSuccess={onPaymentSuccessMock}
      />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/public/portal/${encodeURIComponent(mockToken)}/payments/orders/ORDER-OK-456/capture`,
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            paymentIntentId: "intent-ok-123",
          }),
        })
      );
      expect(screen.getByText("Payment Captured & Verified")).toBeInTheDocument();
      expect(screen.getByText("CAP-CONFIRMED-999")).toBeInTheDocument();
      expect(onPaymentSuccessMock).toHaveBeenCalledWith("CAP-CONFIRMED-999");
    });
  });

  // Scenario 11: Capture timeout / network drop
  it("Scenario 11: transitions to PENDING_RECONCILIATION when network drops during capture", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-drop-123",
      providerOrderId: "ORDER-DROP-456",
    };

    const mockFetch = vi.fn().mockRejectedValueOnce(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-drop-123",
          paymentStatus: "approved",
          orderToken: "ORDER-DROP-456",
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Payment Verification Pending")).toBeInTheDocument();
      expect(screen.getByText(/Connection was interrupted during capture. Do not pay again/i)).toBeInTheDocument();
    });
  });

  // Scenario 12: Ambiguous capture response
  it("Scenario 12: handles ambiguous or pending capture response safely", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-ambig",
      providerOrderId: "ORDER-AMBIG",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        status: "PENDING",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-ambig",
          paymentStatus: "approved",
          orderToken: "ORDER-AMBIG",
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Payment Verification Pending")).toBeInTheDocument();
      expect(screen.getByText(/Payment status is PENDING with PayPal/i)).toBeInTheDocument();
    });
  });

  // Scenario 13: Reconciliation-required response (409)
  it("Scenario 13: renders pending verification alert and blocks second payment on 409 RECONCILIATION_REQUIRED", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-recon",
      providerOrderId: "ORDER-RECON",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({
        error: "RECONCILIATION_REQUIRED",
        message: "Payment requires authoritative reconciliation.",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-recon",
          paymentStatus: "approved",
          orderToken: "ORDER-RECON",
        }}
      />
    );

    await waitFor(() => {
      expect(screen.getByText("Payment Verification Pending")).toBeInTheDocument();
      expect(screen.getByText(/Do not attempt a second payment/i)).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /Check Status/i })).toBeInTheDocument();
    });
  });

  // Scenario 14: Already completed payment
  it("Scenario 14: handles already completed payment and prevents new payment creation", () => {
    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={samplePaidMilestone}
        csrfToken={mockCsrfToken}
      />
    );

    expect(screen.getByText("Payment Captured & Verified")).toBeInTheDocument();
    expect(screen.getByText("CAP-PAYPAL-12345")).toBeInTheDocument();
    expect(screen.queryByText(/Pay with PayPal/i)).not.toBeInTheDocument();
  });

  // Scenario 15: Ineligible milestone
  it("Scenario 15: disables checkout for ineligible milestones", () => {
    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={sampleProjectData}
        csrfToken={mockCsrfToken}
      />
    );

    expect(screen.getByText("Future Scope Expansion")).toBeInTheDocument();
    expect(screen.getByText("Not Payable Yet")).toBeInTheDocument();
    expect(screen.getByText("Not Payable")).toBeInTheDocument();
  });

  // Scenario 16: Session expiry (401)
  it("Scenario 16: handles session expiry (401) with actionable prompt to re-authenticate", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 401,
      json: async () => ({ error: "SESSION_EXPIRED" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={samplePayableMilestone1}
        csrfToken={mockCsrfToken}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      expect(
        screen.getByText(/Your session has expired. Please refresh the page to sign in again/i)
      ).toBeInTheDocument();
    });
  });

  // Scenario 17: CSRF failure (403)
  it("Scenario 17: handles CSRF failure (403) with security refresh prompt", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "INVALID_CSRF_TOKEN" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={samplePayableMilestone1}
        csrfToken={mockCsrfToken}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      expect(
        screen.getByText(/Security token verification failed. Please refresh your browser/i)
      ).toBeInTheDocument();
    });
  });

  // Scenario 18: Cross-project identifier mismatch handling
  it("Scenario 18: handles cross-project mismatch (403 FORBIDDEN) gracefully", async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 403,
      json: async () => ({ error: "FORBIDDEN", reason: "PROJECT_MISMATCH" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={samplePayableMilestone1}
        csrfToken={mockCsrfToken}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      expect(screen.getByText(/Security token verification failed/i)).toBeInTheDocument();
    });
  });

  // Scenario 19: Refresh after successful payment
  it("Scenario 19: workspace renders confirmed Paid state after refresh following completed capture", () => {
    const projectAfterPaid: PortalProjectData = {
      ...sampleProjectData,
      milestones: [
        {
          ...samplePayableMilestone1,
          paymentStatus: "PAID",
          isPayable: false,
          completedCaptureId: "CAP-VERIFIED-LATEST",
        },
      ],
    };

    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={projectAfterPaid}
        csrfToken={mockCsrfToken}
      />
    );

    expect(screen.getByText("Paid (Provider Verified)")).toBeInTheDocument();
    expect(screen.queryByText("Pay Milestone")).not.toBeInTheDocument();
  });

  // Scenario 20: Refresh after ambiguous capture / in-flight capture
  it("Scenario 20: blocks payment action on refresh during in-flight capture or reconciliation", () => {
    const projectInFlightCapture: PortalProjectData = {
      ...sampleProjectData,
      milestones: [
        {
          ...samplePayableMilestone1,
          paymentStatus: "PENDING_VERIFICATION",
          isPayable: false,
        },
      ],
    };

    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={projectInFlightCapture}
        csrfToken={mockCsrfToken}
      />
    );

    const pendingBadges = screen.getAllByText("Pending Verification");
    expect(pendingBadges.length).toBeGreaterThanOrEqual(1);
    expect(screen.queryByText("Pay Milestone")).not.toBeInTheDocument();
  });
});

describe("Phase 3B.5.1: Additional Financial & Lifecycle Invariants", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
  });

  it("permits safe retry for milestone with previously FAILED or CANCELLED intent (AUDIT-3B5-03)", async () => {
    // When an intent previously failed, page.tsx leaves paymentIntentId as null
    const retryMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentIntentId: null, // Nullified by page.tsx on FAILED/CANCELLED
      paymentStatus: "UNPAID",
      isPayable: true,
    };

    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true, paymentIntentId: "fresh-new-intent-id" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          success: true,
          orderId: "fresh-new-order-id",
          approvalUrl: "https://www.sandbox.paypal.com/checkoutnow?token=fresh-new-order-id",
        }),
      });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={retryMilestone}
        csrfToken={mockCsrfToken}
        onRedirectToPayPal={vi.fn()}
      />
    );

    fireEvent.click(screen.getByText(/Pay with PayPal/i));

    await waitFor(() => {
      // Must call /payments/intents to initialize a fresh new intent
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/public/portal/${encodeURIComponent(mockToken)}/payments/intents`,
        expect.anything()
      );
    });
  });

  it("guards against stale or mismatched PayPal return order token before dispatching capture", async () => {
    const milestoneWithExpectedOrder: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-match",
      providerOrderId: "ORDER-EXPECTED-123",
    };

    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={milestoneWithExpectedOrder}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-match",
          paymentStatus: "approved",
          orderToken: "ORDER-OBSOLETE-999",
        }}
      />
    );

    await waitFor(() => {
      expect(
        screen.getByText(
          /Returned PayPal order reference does not match this milestone order. Payment was not captured./i
        )
      ).toBeInTheDocument();
    });

    // Capture endpoint must NOT be called for mismatched order
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("/capture"),
      expect.anything()
    );
  });

  it("does not duplicate capture on unmount and never injects single-merchant PayPal JS SDK", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-unmount",
      providerOrderId: "ORDER-UNMOUNT",
    };

    const mockFetch = vi.fn().mockImplementationOnce(async () => {
      await new Promise((r) => setTimeout(r, 80));
      return {
        ok: true,
        json: async () => ({
          success: true,
          status: "COMPLETED",
          captureId: "CAP-LATE",
        }),
      };
    });
    vi.stubGlobal("fetch", mockFetch);

    const { unmount } = render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-unmount",
          paymentStatus: "approved",
          orderToken: "ORDER-UNMOUNT",
        }}
      />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    unmount();

    await new Promise((r) => setTimeout(r, 120));

    // Capture was only dispatched once and no SDK script was ever injected
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(document.getElementById("paypal-sdk-script")).toBeNull();
    expect((window as unknown as { paypal?: unknown }).paypal).toBeUndefined();
  });

  it("never marks milestone completed based solely on approved PayPal return URL without server confirmation", async () => {
    const inProgressMilestone: PortalMilestone = {
      ...samplePayableMilestone1,
      paymentStatus: "IN_PROGRESS",
      paymentIntentId: "intent-auth-alone",
      providerOrderId: "ORDER-AUTH-ALONE",
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: async () => ({ error: "SERVER_ERROR", message: "Ledger recording failed." }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <MilestoneCheckout
        token={mockToken}
        milestone={inProgressMilestone}
        csrfToken={mockCsrfToken}
        paymentReturn={{
          paymentIntentId: "intent-auth-alone",
          paymentStatus: "approved",
          orderToken: "ORDER-AUTH-ALONE",
        }}
      />
    );

    await waitFor(() => {
      // Must NOT show completed status
      expect(screen.queryByText("Payment Captured & Verified")).not.toBeInTheDocument();
      // Must show error from server
      expect(screen.getByText(/SERVER_ERROR/i)).toBeInTheDocument();
    });
  });

  it("auto-opens matching milestone checkout drawer when returning from PayPal approval via initialPaymentReturn", async () => {
    const projectReturningFromPayPal: PortalProjectData = {
      ...sampleProjectData,
      milestones: [
        samplePaidMilestone,
        {
          ...samplePayableMilestone1,
          paymentStatus: "IN_PROGRESS",
          paymentIntentId: "intent-ws-return",
          providerOrderId: "ORDER-WS-RETURN-1",
          isPayable: true,
        },
        samplePayableMilestone2,
      ],
    };

    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        status: "COMPLETED",
        captureId: "CAP-WS-RETURN-99",
      }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <ClientPortalWorkspaceView
        token={mockToken}
        projectData={projectReturningFromPayPal}
        csrfToken={mockCsrfToken}
        initialPaymentReturn={{
          paymentIntentId: "intent-ws-return",
          paymentStatus: "approved",
          orderToken: "ORDER-WS-RETURN-1",
        }}
      />
    );

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        `/api/public/portal/${encodeURIComponent(mockToken)}/payments/orders/ORDER-WS-RETURN-1/capture`,
        expect.objectContaining({
          method: "POST",
        })
      );
      expect(screen.getByText("Payment Captured & Verified")).toBeInTheDocument();
      expect(screen.getByText("CAP-WS-RETURN-99")).toBeInTheDocument();
    });
  });
});
