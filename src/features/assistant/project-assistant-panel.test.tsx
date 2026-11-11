import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ProjectAssistantPanel } from "./project-assistant-panel";
import type { ProjectAssistantReply } from "./schema";

describe("ProjectAssistantPanel UI Component (AI-6)", () => {
  const projectId = "f47ac10b-58cc-4372-a567-0e02b2c3d479";
  const portalToken = "valid-portal-token-for-assistant-ui-123456";
  const csrfToken = "csrf-secret-value-1234567890";

  function buildReply(overrides?: Partial<ProjectAssistantReply>): ProjectAssistantReply {
    return {
      answerStatus: "ANSWERED",
      summary: "Agreement v1 is approved with 2 milestones and 1 open change request.",
      recordedFacts: [
        {
          fact: "Agreement v1 was approved by the client.",
          authorityLabel: "APPROVED_AGREEMENT",
          sourceRef: "Agreement v1 (APPROVED)",
        },
      ],
      aiInterpretation: "Agreement terms remain unchanged by the open change request.",
      uncertaintiesAndGaps: ["PayRoost does not track downstream bank payout settlement."],
      clarificationQuestions: ["Did you want details on Milestone 2 deliverables?"],
      recommendedNextSteps: ["Review Change Request #1 under Scope Changes."],
      isAiGenerated: true,
      readOnlyNotice:
        "AI-generated read-only summary based on PayRoost project records. AI outputs do not constitute legal advice and cannot modify agreements, milestones, change requests, or payments.",
      model: "gemini-3.8-flash",
      participantRole: "OWNER",
      generatedAt: "2026-11-11T12:00:00.000Z",
      contextStats: {
        approvedAgreementVersion: 1,
        currentAgreementVersion: 1,
        milestoneCount: 2,
        openChangeRequestCount: 1,
        recordedPaymentIntentCount: 0,
      },
      ...overrides,
    };
  }

  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders suggested questions, separates recorded facts from AI interpretation, maintains session history, and clears session state", async () => {
    const firstReply = buildReply();
    const secondReply = buildReply({
      answerStatus: "INSUFFICIENT_INFORMATION",
      summary: "No rationale was logged in PayRoost explaining why the timeline changed.",
      recordedFacts: [],
      aiInterpretation: null,
    });

    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { reply: firstReply } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { reply: secondReply } }),
      });

    render(
      <ProjectAssistantPanel
        mode="freelancer"
        projectId={projectId}
        projectTitle="Acme Portal"
        canUseAi={true}
      />
    );

    fireEvent.click(screen.getByRole("button", { name: "What have we agreed to deliver?" }));

    await waitFor(() => {
      expect(
        screen.getByText(/Agreement v1 is approved with 2 milestones/i)
      ).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/ai/project-assistant",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId,
          question: "What have we agreed to deliver?",
          history: [],
        }),
      })
    );

    expect(screen.getByText(/Recorded PayRoost Facts \(1\)/i)).toBeTruthy();
    expect(screen.getByText("Approved Agreement")).toBeTruthy();
    expect(screen.getByText("Source: Agreement v1 (APPROVED)")).toBeTruthy();
    expect(
      screen.getByText(/AI Interpretation \(Not an Authoritative Record\)/i)
    ).toBeTruthy();
    expect(screen.getByText(/Missing, Uncertain, or Conflicting Information/i)).toBeTruthy();

    // Ask follow-up turn via textarea
    const input = screen.getByLabelText(/Ask about this project/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Why was the timeline revised?" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask Assistant/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/No rationale was logged in PayRoost/i)
      ).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/ai/project-assistant",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          projectId,
          question: "Why was the timeline revised?",
          history: [
            { role: "user", content: "What have we agreed to deliver?" },
            { role: "assistant", content: firstReply.summary },
          ],
        }),
      })
    );

    // Clear session chat clears local messages cleanly
    fireEvent.click(screen.getByRole("button", { name: /Clear Session Chat/i }));
    expect(screen.queryByText(/No rationale was logged in PayRoost/i)).toBeNull();
  });

  it("sends x-csrf-token and uses verified portal route without projectId in client mode, preserving draft question on error", async () => {
    const clientReply = buildReply({ participantRole: "CLIENT" });

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ message: "AI rate limit reached." }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { reply: clientReply } }),
      });

    render(
      <ProjectAssistantPanel
        mode="client"
        portalToken={portalToken}
        csrfToken={csrfToken}
        projectTitle="Acme Portal"
        canUseAi={true}
      />
    );

    const input = screen.getByLabelText(/Ask about this project/i) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "Which deliverables are submitted?" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask Assistant/i }));

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("AI rate limit reached.");
    });
    expect(input.value).toBe("Which deliverables are submitted?");

    fireEvent.click(screen.getByRole("button", { name: /Ask Assistant/i }));
    await waitFor(() => {
      expect(screen.getByText(/Agreement v1 is approved/i)).toBeTruthy();
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `/api/public/portal/${encodeURIComponent(portalToken)}/assistant`,
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
        },
        body: JSON.stringify({
          question: "Which deliverables are submitted?",
          history: [],
        }),
      })
    );
  });

  it("renders unavailable notice cleanly when GEMINI_API_KEY is not configured", () => {
    render(
      <ProjectAssistantPanel
        mode="freelancer"
        projectId={projectId}
        projectTitle="Acme Portal"
        canUseAi={false}
      />
    );

    expect(
      screen.getByText(/Project Assistant is unavailable because `GEMINI_API_KEY` is not configured/i)
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Ask Assistant/i })).toBeNull();
  });
});
