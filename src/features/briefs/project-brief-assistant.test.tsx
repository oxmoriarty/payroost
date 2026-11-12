import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ProjectBriefAssistant } from "./project-brief-assistant";
import type { StructuredBrief } from "./schema";

describe("ProjectBriefAssistant UI Component", () => {
  const sampleBrief: StructuredBrief = {
    title: "Brand Apparel Store",
    summary: "Full-featured e-commerce storefront for selling clothing items.",
    objectives: ["Launch online sales"],
    functionalRequirements: ["Product catalog", "Checkout"],
    nonFunctionalRequirements: ["Mobile responsiveness"],
    deliverables: ["Next.js web application", "CMS setup"],
    scopeInclusions: ["Storefront development"],
    scopeExclusions: ["Inventory photo shoots"],
    assumptions: ["Client provides product imagery and sizing charts"],
    constraints: ["Standard web browser support"],
    dependencies: ["Stripe account API access"],
    timelineExpectations: "Target launch in 4 weeks",
    risks: ["Delay in catalog preparation"],
    openQuestions: ["Which payment methods are required?"],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the initial input state without removed helper copy and with disabled submit when input is too short", () => {
    render(<ProjectBriefAssistant />);

    expect(screen.getByText("AI Project Brief Assistant")).toBeInTheDocument();
    expect(screen.getByLabelText("Client project description")).toBeInTheDocument();
    expect(screen.queryByText(/Free Tier/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Transform rough client notes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/All AI output is reviewed by you before use/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Untrusted client input is isolated/i)).not.toBeInTheDocument();

    const submitBtn = screen.getByRole("button", { name: /structure brief with ai/i });
    expect(submitBtn).toBeDisabled();
  });

  it("enables the submit button once description reaches minimum 10 characters", () => {
    render(<ProjectBriefAssistant />);

    const textarea = screen.getByLabelText("Client project description");
    fireEvent.change(textarea, { target: { value: "Build an e-commerce website for shoes." } });

    const submitBtn = screen.getByRole("button", { name: /structure brief with ai/i });
    expect(submitBtn).not.toBeDisabled();
  });

  it("displays loading state while waiting for AI generation response", async () => {
    let resolveResponse: (val: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveResponse = resolve;
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(fetchPromise)
    );

    render(<ProjectBriefAssistant initialDescription="Build an e-commerce website for shoes." />);

    const submitBtn = screen.getByRole("button", { name: /structure brief with ai/i });
    fireEvent.click(submitBtn);

    expect(screen.getByText("Analyzing & Structuring Brief")).toBeInTheDocument();
    expect(screen.getByText(/Powered by Gemini 3.8 Flash Free Tier/i)).toBeInTheDocument();

    // Cleanup promise
    resolveResponse!({
      ok: true,
      json: () => Promise.resolve({ data: { brief: sampleBrief } }),
    });
  });

  it("renders structured brief preview on success with open questions and assumptions visibility", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { brief: sampleBrief } }),
      })
    );

    render(<ProjectBriefAssistant initialDescription="Build an e-commerce website for shoes." />);

    const submitBtn = screen.getByRole("button", { name: /structure brief with ai/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText("Review Structured Project Brief")).toBeInTheDocument();
      expect(screen.getByDisplayValue("Brand Apparel Store")).toBeInTheDocument();
    });

    // Check distinct badge visibility for assumptions and open questions
    expect(screen.getByText("Needs Confirmation")).toBeInTheDocument();
    expect(screen.getByText("Requires Clarification")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Client provides product imagery and sizing charts")).toBeInTheDocument();
    expect(screen.getByDisplayValue("Which payment methods are required?")).toBeInTheDocument();
  });

  it("allows user to edit fields and add/remove deliverables in review mode", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { brief: sampleBrief } }),
      })
    );

    render(<ProjectBriefAssistant initialDescription="Build an e-commerce website for shoes." />);

    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Project title")).toBeInTheDocument();
    });

    // Edit title
    const titleInput = screen.getByLabelText("Project title");
    fireEvent.change(titleInput, { target: { value: "Updated Custom Store Title" } });
    expect(titleInput).toHaveValue("Updated Custom Store Title");

    // Remove first deliverable
    const removeBtn = screen.getByLabelText("Remove deliverable 1");
    fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(screen.queryByDisplayValue("Next.js web application")).not.toBeInTheDocument();
      expect(screen.getByDisplayValue("CMS setup")).toBeInTheDocument();
    });
  });

  it("displays specific actionable messages for config, rate-limiter, rate-limit, timeout, and 503 errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: () => Promise.resolve({ error: "AI_UNAVAILABLE" }),
      })
    );

    render(<ProjectBriefAssistant initialDescription="Build an e-commerce website for shoes." />);

    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
      expect(screen.getByText(/AI service is temporarily unavailable/i)).toBeInTheDocument();
    });

    // Server config error with safe actionable message
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 500,
      json: () =>
        Promise.resolve({
          error: "AI_CONFIG_ERROR",
          message: "GEMINI_API_KEY is not configured on the server.",
        }),
    } as Response);
    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));
    await waitFor(() => {
      expect(screen.getByText(/GEMINI_API_KEY is not configured/i)).toBeInTheDocument();
    });

    // Rate limiter DB unavailable vs AI unavailable
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({ error: "RATE_LIMITER_UNAVAILABLE" }),
    } as Response);
    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));
    await waitFor(() => {
      expect(screen.getByText(/Rate limiting service is temporarily unavailable/i)).toBeInTheDocument();
    });

    // Non-JSON gateway timeout (e.g. Vercel/proxy 504 HTML)
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 504,
      json: () => Promise.reject(new SyntaxError("Unexpected token <")),
    } as unknown as Response);
    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));
    await waitFor(() => {
      expect(screen.getByText(/timed out before finishing/i)).toBeInTheDocument();
    });

    // Schema output invalid 422
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: () => Promise.resolve({ error: "AI_OUTPUT_INVALID" }),
    } as Response);
    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));
    await waitFor(() => {
      expect(screen.getByText(/incomplete brief/i)).toBeInTheDocument();
    });
  });

  it("allows user to regenerate the brief", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { brief: sampleBrief } }),
      })
    );

    render(<ProjectBriefAssistant initialDescription="Build an e-commerce website for shoes." />);

    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /regenerate/i })).toBeInTheDocument();
    });

    // Click regenerate to return to notes input
    fireEvent.click(screen.getByRole("button", { name: /regenerate/i }));

    await waitFor(() => {
      expect(screen.getByLabelText("Client project description")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: /structure brief with ai/i })).toBeInTheDocument();
    });
  });

  it("triggers onApplyBrief callback upon explicit continuation action", async () => {
    const handleApply = vi.fn();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: { brief: sampleBrief } }),
      })
    );

    render(
      <ProjectBriefAssistant
        initialDescription="Build an e-commerce website for shoes."
        onApplyBrief={handleApply}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: /structure brief with ai/i }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /apply to project brief/i })).toBeInTheDocument();
    });

    // Click Apply
    fireEvent.click(screen.getByRole("button", { name: /apply to project brief/i }));

    expect(handleApply).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Brand Apparel Store",
        deliverables: ["Next.js web application", "CMS setup"],
      })
    );

    expect(screen.getByText("Structured Brief Applied")).toBeInTheDocument();
  });
});
