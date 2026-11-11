import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { PayPalSellerSettingsCard } from "./paypal-seller-settings-card";

let mockSearchParams = new URLSearchParams();
vi.mock("next/navigation", () => ({
  useSearchParams: () => mockSearchParams,
}));

describe("PayPalSellerSettingsCard UI States", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders 'Not Connected' state when freelancer has no seller account", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: false,
        onboardingStatus: "NOT_STARTED",
        paymentsReceivable: false,
        primaryEmailConfirmed: false,
        sellerMerchantIdMasked: null,
        sellerEmail: null,
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    expect(screen.getByText(/Loading seller connection details/i)).toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("Not Connected")).toBeInTheDocument();
      expect(screen.getByText("Connect PayPal Sandbox Seller Account")).toBeInTheDocument();
      expect(screen.getByText(/Model 1 Platform Marketplace/i)).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("renders 'Connected & Ready' state with masked merchant ID when verified", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: true,
        onboardingStatus: "COMPLETED",
        paymentsReceivable: true,
        primaryEmailConfirmed: true,
        sellerMerchantIdMasked: "XYZ***123",
        sellerEmail: "freelancer_seller@sandbox.test",
        connectedAt: "2026-11-10T15:00:00Z",
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Connected & Ready")).toBeInTheDocument();
      expect(screen.getByText("XYZ***123")).toBeInTheDocument();
      expect(screen.getByText("Enabled (Direct Payee)")).toBeInTheDocument();
      expect(screen.getByText("freelancer_seller@sandbox.test")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("renders 'Action Required' when seller onboarding failed or payments are not receivable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: false,
        onboardingStatus: "FAILED",
        paymentsReceivable: false,
        primaryEmailConfirmed: false,
        sellerMerchantIdMasked: "UNR***456",
        sellerEmail: null,
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Action Required")).toBeInTheDocument();
      expect(screen.getByText("Connect PayPal Sandbox Seller Account")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("displays success banner when paypal_status=connected in URL query", async () => {
    mockSearchParams = new URLSearchParams("paypal_status=connected");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: true,
        onboardingStatus: "COMPLETED",
        paymentsReceivable: true,
        primaryEmailConfirmed: true,
        sellerMerchantIdMasked: "MER***789",
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("PayPal Seller Account Connected Successfully")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("displays already connected banner when paypal_status=already_connected", async () => {
    mockSearchParams = new URLSearchParams("paypal_status=already_connected");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: true,
        onboardingStatus: "COMPLETED",
        paymentsReceivable: true,
        primaryEmailConfirmed: true,
        sellerMerchantIdMasked: "ALR***123",
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("PayPal Seller Account Already Connected")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("displays in-flight banner when paypal_status=processing", async () => {
    mockSearchParams = new URLSearchParams("paypal_status=processing");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: false,
        onboardingStatus: "PROCESSING",
        paymentsReceivable: false,
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Verification In Flight")).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("displays error banner when paypal_status=config_error or verification_failed", async () => {
    mockSearchParams = new URLSearchParams("paypal_status=config_error");

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        isConnected: false,
        onboardingStatus: "FAILED",
        paymentsReceivable: false,
      }),
    }));

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Connection Failed")).toBeInTheDocument();
      expect(screen.getByText(/partner configuration is missing or invalid/i)).toBeInTheDocument();
    });

    vi.unstubAllGlobals();
  });

  it("calls onboard API on Connect button click and redirects", async () => {
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          isConnected: false,
          onboardingStatus: "NOT_STARTED",
          paymentsReceivable: false,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          actionUrl: "https://www.sandbox.paypal.com/bizsignup/partner/entry?token=test_tok",
        }),
      });

    vi.stubGlobal("fetch", mockFetch);

    // Mock window.location
    const originalLocation = window.location;
    delete (window as unknown as { location?: Location }).location;
    (window as unknown as { location: { href: string } }).location = { href: "" };

    render(<PayPalSellerSettingsCard />);

    await waitFor(() => {
      expect(screen.getByText("Connect PayPal Sandbox Seller Account")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText("Connect PayPal Sandbox Seller Account"));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/app/freelancer/paypal/onboard",
        expect.objectContaining({ method: "POST" })
      );
      expect(window.location.href).toBe("https://www.sandbox.paypal.com/bizsignup/partner/entry?token=test_tok");
    });

    (window as unknown as { location: Location }).location = originalLocation;
    vi.unstubAllGlobals();
  });
});
