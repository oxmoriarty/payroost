import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PortalInviteCard } from "@/features/projects/portal-invite-card";

describe("PortalInviteCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("disables portal invitation until client email is verified", () => {
    render(
      <PortalInviteCard
        projectId="proj-123"
        isClientVerified={false}
        clientName="Acme Client"
        clientEmail="client@acme.com"
        agreementApproved={false}
      />,
    );

    expect(screen.getByRole("button", { name: /send client portal invite/i })).toBeDisabled();
    expect(screen.getByText(/locked until the client confirms their email/i)).toBeInTheDocument();
  });

  it("sends portal invite request and displays email delivery confirmation without exposing raw tokens", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ success: true, expiresAt: "2026-11-18T12:00:00Z" }),
    });
    vi.stubGlobal("fetch", mockFetch);

    render(
      <PortalInviteCard
        projectId="proj-123"
        isClientVerified={true}
        clientName="Acme Client"
        clientEmail="client@acme.com"
        agreementApproved={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /send client portal invite/i }));

    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/projects/proj-123/portal-link",
        expect.objectContaining({ method: "POST" }),
      );
      expect(
        screen.getByText(/OTP-protected Client Portal invitation was emailed directly to client@acme.com/i),
      ).toBeInTheDocument();
    });
  });

  it("surfaces rate-limit and provider errors cleanly", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ error: "RATE_LIMITED" }),
      }),
    );

    render(
      <PortalInviteCard
        projectId="proj-123"
        isClientVerified={true}
        clientName="Acme Client"
        clientEmail="client@acme.com"
        agreementApproved={true}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /send client portal invite/i }));

    await waitFor(() => {
      expect(screen.getByText(/Too many invite requests/i)).toBeInTheDocument();
    });
  });
});
