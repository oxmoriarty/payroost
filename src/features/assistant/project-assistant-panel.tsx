"use client";

import { useState } from "react";
import {
  AlertTriangle,
  BookOpen,
  Bot,
  Eraser,
  HelpCircle,
  Send,
  ShieldCheck,
  Sparkles,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  AssistantAnswerStatus,
  AssistantAuthorityLabel,
  AssistantConversationTurn,
  ProjectAssistantReply,
} from "@/features/assistant/schema";

export interface ProjectAssistantPanelProps {
  mode: "freelancer" | "client";
  projectId?: string;
  portalToken?: string;
  csrfToken?: string;
  projectTitle: string;
  canUseAi: boolean;
}

type ChatMessageItem =
  | {
      id: string;
      role: "user";
      content: string;
    }
  | {
      id: string;
      role: "assistant";
      reply: ProjectAssistantReply;
    };

const SUGGESTED_QUESTIONS_FREELANCER = [
  "What have we agreed to deliver?",
  "Which milestones are still outstanding?",
  "What changed after the original agreement?",
  "What is the current status of the latest scope-change request?",
  "What payments have been recorded, and which milestones do they relate to?",
  "What does the client still need to review?",
] as const;

const SUGGESTED_QUESTIONS_CLIENT = [
  "What have we agreed to deliver?",
  "Which deliverables have been submitted or accepted?",
  "What does the client still need to review?",
  "What payments have been recorded, and which milestones do they relate to?",
  "What is the current status of the latest scope-change request?",
  "Are there unresolved questions or dependencies?",
] as const;

function answerStatusMeta(status: AssistantAnswerStatus): {
  label: string;
  tone: "success" | "warning" | "info" | "neutral";
} {
  switch (status) {
    case "ANSWERED":
      return { label: "Grounded Answer", tone: "success" };
    case "PARTIAL_INFORMATION":
      return { label: "Partial Information", tone: "warning" };
    case "INSUFFICIENT_INFORMATION":
      return { label: "Insufficient Information", tone: "warning" };
    case "CONFLICTING_RECORDS":
      return { label: "Conflicting Records", tone: "warning" };
    case "ACTION_REDIRECT":
      return { label: "Read-Only Workflow Guidance", tone: "info" };
  }
}

function authorityBadgeMeta(authority: AssistantAuthorityLabel): {
  label: string;
  tone: "success" | "warning" | "info" | "neutral";
} {
  switch (authority) {
    case "APPROVED_AGREEMENT":
      return { label: "Approved Agreement", tone: "success" };
    case "CURRENT_DRAFT_OR_PENDING":
      return { label: "Draft / Pending Review", tone: "warning" };
    case "HISTORICAL_VERSION":
      return { label: "Historical Version", tone: "neutral" };
    case "MILESTONE_RECORD":
      return { label: "Milestone Record", tone: "info" };
    case "SUBMITTED_CHANGE_REQUEST":
      return { label: "Submitted Change Request", tone: "info" };
    case "AI_SCOPE_PROPOSAL":
      return { label: "AI Scope Proposal (Non-Contractual)", tone: "warning" };
    case "PAYMENT_RECORD":
      return { label: "Payment Ledger Record", tone: "info" };
    case "PROJECT_RECORD":
      return { label: "Project Record", tone: "neutral" };
    case "ACTIVITY_LOG":
      return { label: "Activity History", tone: "neutral" };
    case "SYSTEM_BOUNDARY":
      return { label: "System Boundary", tone: "neutral" };
  }
}

export function ProjectAssistantPanel({
  mode,
  projectId,
  portalToken,
  csrfToken,
  projectTitle,
  canUseAi,
}: ProjectAssistantPanelProps) {
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<ChatMessageItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const suggestedQuestions =
    mode === "client" ? SUGGESTED_QUESTIONS_CLIENT : SUGGESTED_QUESTIONS_FREELANCER;

  const endpoint =
    mode === "client" && portalToken
      ? `/api/public/portal/${encodeURIComponent(portalToken)}/assistant`
      : "/api/ai/project-assistant";

  function buildHeaders(): HeadersInit {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (mode === "client" && csrfToken) {
      headers["x-csrf-token"] = csrfToken;
    }
    return headers;
  }

  function toHistoryTurns(items: ChatMessageItem[]): AssistantConversationTurn[] {
    return items.slice(-8).map((item) => ({
      role: item.role,
      content: item.role === "user" ? item.content : item.reply.summary.slice(0, 2000),
    }));
  }

  async function submitQuestion(rawQuestion: string) {
    const trimmed = rawQuestion.trim();
    if (!canUseAi || busy) return;
    if (trimmed.length < 2) {
      setErrorMsg("Please enter a question of at least 2 characters.");
      return;
    }

    setBusy(true);
    setErrorMsg(null);

    const history = toHistoryTurns(messages);
    const body =
      mode === "client"
        ? { question: trimmed, history }
        : { projectId, question: trimmed, history };

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: buildHeaders(),
        body: JSON.stringify(body),
      });

      const json = (await response.json()) as {
        data?: { reply?: ProjectAssistantReply };
        error?: string;
        message?: string;
      };

      if (!response.ok || !json.data?.reply) {
        setErrorMsg(
          json.message ?? json.error ?? "Unable to get a response from the project assistant right now."
        );
        return;
      }

      const reply = json.data.reply;
      setMessages((prev) => {
        const turnIndex = prev.length;
        return [
          ...prev,
          { id: `u-${turnIndex}`, role: "user", content: trimmed },
          { id: `a-${turnIndex}`, role: "assistant", reply },
        ];
      });
      setQuestion("");
    } catch {
      setErrorMsg("Network error contacting the project assistant.");
    } finally {
      setBusy(false);
    }
  }

  function handleClearChat() {
    setMessages([]);
    setErrorMsg(null);
  }

  return (
    <Card className="p-6 space-y-5">
      {/* Header & Grounding Disclaimer */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Bot className="h-5 w-5 text-teal-700" />
            <h2 className="font-display text-xl text-ink-950">Project Assistant</h2>
            <Badge tone="info">AI-Generated</Badge>
            <Badge tone="neutral">Read-Only</Badge>
          </div>
          <p className="mt-1 text-xs text-ink-600 leading-relaxed">
            Ask questions about <strong>{projectTitle}</strong>&apos;s agreements, milestones, scope
            changes, payment records, and activity history. Responses are grounded in authoritative
            PayRoost records and never modify contracts, milestones, change requests, or payments.
          </p>
        </div>

        {messages.length > 0 && (
          <Button
            type="button"
            variant="ghost"
            className="text-xs shrink-0"
            disabled={busy}
            onClick={handleClearChat}
          >
            <Eraser className="mr-1.5 h-3.5 w-3.5" />
            Clear Session Chat
          </Button>
        )}
      </div>

      {/* Privacy & Free-Tier Transparency Banner */}
      <div className="rounded-xl border border-slate-200 bg-slate-50/80 p-3.5 text-xs text-ink-700 flex items-start gap-2.5">
        <ShieldCheck className="h-4 w-4 shrink-0 text-teal-700 mt-0.5" />
        <p>
          <strong>Session-only &amp; Privacy Notice:</strong> Chat messages stay in your current
          browser session only and are not stored in PayRoost&apos;s database. Prompts use Gemini
          3.8 Flash Free Tier with unnecessary emails, account credentials, and private PayPal IDs
          stripped; avoid pasting sensitive secrets in questions. Not legal advice.
        </p>
      </div>

      {/* Suggested Questions */}
      {canUseAi && (
        <div className="space-y-2">
          <p className="text-[11px] font-bold uppercase tracking-wider text-ink-500">
            Suggested Questions
          </p>
          <div className="flex flex-wrap gap-2">
            {suggestedQuestions.map((promptText) => (
              <button
                key={promptText}
                type="button"
                disabled={busy}
                onClick={() => submitQuestion(promptText)}
                className="rounded-full border border-ink-200 bg-white px-3 py-1.5 text-xs font-medium text-ink-800 transition hover:border-teal-500 hover:bg-teal-50/50 hover:text-teal-900 disabled:pointer-events-none disabled:opacity-50"
              >
                {promptText}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Session Conversation Thread */}
      {messages.length > 0 && (
        <div className="space-y-4 max-h-[34rem] overflow-y-auto pr-1" aria-live="polite">
          {messages.map((item) => {
            if (item.role === "user") {
              return (
                <div key={item.id} className="flex justify-end">
                  <div className="max-w-2xl rounded-2xl bg-teal-700 px-4 py-3 text-sm text-white shadow-sm">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-teal-100 mb-1">
                      You
                    </p>
                    <p className="whitespace-pre-wrap">{item.content}</p>
                  </div>
                </div>
              );
            }

            const { reply } = item;
            const statusMeta = answerStatusMeta(reply.answerStatus);

            return (
              <div
                key={item.id}
                className="rounded-2xl border border-ink-100 bg-slate-50/60 p-4 space-y-4"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge tone={statusMeta.tone}>{statusMeta.label}</Badge>
                    <Badge tone="neutral">AI-Generated · Read-Only</Badge>
                  </div>
                  <span className="text-[11px] text-ink-500">Model: {reply.model}</span>
                </div>

                <p className="text-sm text-ink-950 leading-relaxed whitespace-pre-wrap">
                  {reply.summary}
                </p>

                {/* Recorded Facts with Citations */}
                {reply.recordedFacts.length > 0 && (
                  <div className="rounded-xl border border-ink-100 bg-white p-3.5 space-y-2.5">
                    <div className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-ink-700">
                      <BookOpen className="h-3.5 w-3.5 text-teal-700" />
                      <span>Recorded PayRoost Facts ({reply.recordedFacts.length})</span>
                    </div>
                    <ul className="space-y-2 text-xs">
                      {reply.recordedFacts.map((claim, idx) => {
                        const authMeta = authorityBadgeMeta(claim.authorityLabel);
                        return (
                          <li key={idx} className="rounded-lg bg-slate-50 p-2.5 space-y-1">
                            <div className="flex flex-wrap items-center gap-1.5">
                              <Badge tone={authMeta.tone}>{authMeta.label}</Badge>
                              <span className="rounded-md border border-ink-200 bg-white px-2 py-0.5 text-[11px] font-medium text-ink-700">
                                Source: {claim.sourceRef}
                              </span>
                            </div>
                            <p className="text-ink-900 leading-relaxed">{claim.fact}</p>
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {/* Separate AI Interpretation Box */}
                {reply.aiInterpretation && (
                  <div className="rounded-xl border border-teal-200 bg-teal-50/50 p-3.5 space-y-1 text-xs">
                    <div className="flex items-center gap-1.5 font-bold uppercase tracking-wider text-teal-900">
                      <Sparkles className="h-3.5 w-3.5 text-teal-700" />
                      <span>AI Interpretation (Not an Authoritative Record)</span>
                    </div>
                    <p className="text-teal-950 leading-relaxed whitespace-pre-wrap">
                      {reply.aiInterpretation}
                    </p>
                  </div>
                )}

                {/* Missing / Conflicting Info */}
                {reply.uncertaintiesAndGaps.length > 0 && (
                  <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 space-y-1.5 text-xs text-amber-950">
                    <div className="flex items-center gap-1.5 font-bold">
                      <AlertTriangle className="h-3.5 w-3.5 text-amber-700" />
                      <span>Missing, Uncertain, or Conflicting Information</span>
                    </div>
                    <ul className="list-disc pl-4 space-y-1">
                      {reply.uncertaintiesAndGaps.map((gap, idx) => (
                        <li key={idx}>{gap}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Clarifying Questions */}
                {reply.clarificationQuestions.length > 0 && (
                  <div className="rounded-xl border border-ink-100 bg-white p-3.5 space-y-1.5 text-xs">
                    <div className="flex items-center gap-1.5 font-bold text-ink-800">
                      <HelpCircle className="h-3.5 w-3.5 text-teal-700" />
                      <span>Clarifying Questions</span>
                    </div>
                    <ul className="list-disc pl-4 space-y-1 text-ink-700">
                      {reply.clarificationQuestions.map((qText, idx) => (
                        <li key={idx}>{qText}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {/* Read-Only Workflow Guidance */}
                {reply.recommendedNextSteps.length > 0 && (
                  <div className="rounded-xl border border-ink-100 bg-white p-3.5 space-y-1.5 text-xs">
                    <p className="font-bold uppercase tracking-wider text-ink-700">
                      Read-Only Next Steps
                    </p>
                    <ul className="list-disc pl-4 space-y-1 text-ink-800">
                      {reply.recommendedNextSteps.map((step, idx) => (
                        <li key={idx}>{step}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <p className="text-[11px] text-ink-500">{reply.readOnlyNotice}</p>
              </div>
            );
          })}
        </div>
      )}

      {/* Composer */}
      {!canUseAi ? (
        <div className="rounded-xl border border-ink-100 bg-slate-50 p-4 text-xs text-ink-600">
          Project Assistant is unavailable because `GEMINI_API_KEY` is not configured on the
          server.
        </div>
      ) : (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            submitQuestion(question);
          }}
        >
          {errorMsg && (
            <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-900">
              {errorMsg}
            </div>
          )}

          <label className="block text-sm font-semibold text-ink-900">
            Ask about this project
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              rows={3}
              maxLength={2000}
              disabled={busy}
              placeholder="Ask about deliverables, milestone statuses, agreement revisions, scope changes, payments, or pending reviews..."
              className="mt-2 w-full rounded-xl border border-ink-200 bg-white p-3 text-sm font-normal text-ink-900 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
            />
          </label>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-ink-500">
              Context refreshes from PayRoost records on every question.
            </span>
            <Button type="submit" disabled={busy || question.trim().length < 2}>
              <Send className="mr-1.5 h-4 w-4" />
              {busy ? "Analyzing Project..." : "Ask Assistant"}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
