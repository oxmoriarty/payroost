"use client";

import { useMemo, useState } from "react";
import { Bot, Copy, Eye, FilePlus2, Plus, Send, Trash2 } from "lucide-react";
import { agreementDraftSchema, type AgreementDraft } from "@/features/agreements/schema";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";

type Version = { id: string; version_number: number; content: unknown; status: string; created_at: string; sent_at: string | null; approved_at: string | null };

function getDraft(version: Version | null) { const parsed = agreementDraftSchema.safeParse(version?.content); return parsed.success ? parsed.data : null; }
function lines(value: string) { return value.split("\n").map((item) => item.trim()).filter(Boolean); }

export function updateScopeItem(
  items: AgreementDraft["scopeItems"],
  index: number,
  patch: Partial<AgreementDraft["scopeItems"][number]>
): AgreementDraft["scopeItems"] {
  return items.map((item, i) => (i === index ? { ...item, ...patch } : item));
}

export function addScopeItem(
  items: AgreementDraft["scopeItems"],
  newItem?: Partial<AgreementDraft["scopeItems"][number]>
): AgreementDraft["scopeItems"] {
  const nextIndex = items.length + 1;
  const defaultItem: AgreementDraft["scopeItems"][number] = {
    id: `scope-${Date.now()}-${nextIndex}`,
    title: `Scope item ${nextIndex}`,
    description: "",
    deliverables: [],
    acceptanceCriteria: [],
    assumptions: [],
    ...newItem,
  };
  return [...items, defaultItem];
}

export function removeScopeItem(
  items: AgreementDraft["scopeItems"],
  index: number
): AgreementDraft["scopeItems"] {
  if (items.length <= 1) return items;
  return items.filter((_, i) => i !== index);
}

export function updateMilestone(
  milestones: AgreementDraft["milestones"],
  index: number,
  patch: Partial<AgreementDraft["milestones"][number]>
): AgreementDraft["milestones"] {
  return milestones.map((m, i) => (i === index ? { ...m, ...patch } : m));
}

export function addMilestone(
  milestones: AgreementDraft["milestones"],
  currency: string = "USD",
  newMilestone?: Partial<AgreementDraft["milestones"][number]>
): AgreementDraft["milestones"] {
  const nextIndex = milestones.length + 1;
  const defaultMilestone: AgreementDraft["milestones"][number] = {
    id: `milestone-${Date.now()}-${nextIndex}`,
    title: `Milestone ${nextIndex}`,
    description: "",
    amountMinor: 10000,
    currency,
    dueDate: null,
    deliverables: [],
    acceptanceCriteria: [],
    ...newMilestone,
  };
  return [...milestones, defaultMilestone];
}

export function removeMilestone(
  milestones: AgreementDraft["milestones"],
  index: number
): AgreementDraft["milestones"] {
  if (milestones.length <= 1) return milestones;
  return milestones.filter((_, i) => i !== index);
}

export function AgreementEditor({
  projectId,
  versions,
  canUseAi,
  isClientVerified = true,
  clientEmail,
}: {
  projectId: string;
  versions: Version[];
  canUseAi: boolean;
  isClientVerified?: boolean;
  clientEmail?: string;
}) {
  const draftVersion = versions.find((version) => version.status === "DRAFT") ?? null;
  const initial = useMemo(() => getDraft(draftVersion), [draftVersion]);
  const [draft, setDraft] = useState<AgreementDraft | null>(initial);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reviewUrl, setReviewUrl] = useState<string | null>(null);

  function setValue<K extends keyof AgreementDraft>(key: K, value: AgreementDraft[K]) { if (draft) setDraft({ ...draft, [key]: value }); }
  async function request(path: string, body: unknown) { const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); const json = await response.json() as { data?: unknown; error?: string; reviewUrl?: string }; if (!response.ok) throw new Error(json.error ?? "Request failed"); return json; }
  async function createManual() { setBusy(true); setNotice(null); try { const json = await request(`/api/projects/${projectId}/agreement`, { action: "CREATE_MANUAL" }); setNotice("Draft created. Refresh the page to load it into the editor."); if (json.data) window.location.reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to create a draft."); } finally { setBusy(false); } }
  async function generate() { setBusy(true); setNotice(null); try { await request("/api/ai/generate-agreement", { projectId }); setNotice("AI draft generated. Refreshing…"); window.location.reload(); } catch (error) { setNotice(error instanceof Error ? error.message : "AI is unavailable. You can continue manually."); } finally { setBusy(false); } }
  async function save() { if (!draft) return; setBusy(true); setNotice(null); try { await request(`/api/projects/${projectId}/agreement`, { content: draft }); setNotice("Draft saved."); } catch (error) { setNotice(error instanceof Error ? error.message : "Unable to save the draft."); } finally { setBusy(false); } }
  async function sendForReview() {
    if (!draft) return;
    if (!isClientVerified) {
      setNotice("Client must verify their email before you can send the agreement for review.");
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await save();
      const json = await request(`/api/projects/${projectId}/review-link`, { expiresInDays: 14 });
      setReviewUrl(json.reviewUrl ?? null);
      setNotice("Agreement sent for review. Copy the secure link below.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Unable to send this agreement.");
    } finally {
      setBusy(false);
    }
  }

  if (!draft) return <Card className="p-6"><p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Agreement</p><h2 className="mt-2 font-display text-2xl text-ink-950">Start with a reviewable draft.</h2><p className="mt-3 max-w-xl text-ink-700">You can begin with a manual structured draft. {canUseAi ? "Gemini can also suggest an editable draft from the project brief." : "Gemini is not configured, so manual drafting is available."}</p>{notice && <Notice message={notice} />}<div className="mt-6 flex flex-wrap gap-3"><Button disabled={busy} onClick={createManual}><FilePlus2 className="mr-2" size={16} />Create manual draft</Button>{canUseAi && <Button disabled={busy} onClick={generate} variant="secondary"><Bot className="mr-2" size={16} />Generate with AI</Button>}</div></Card>;

  return (
    <div className="grid gap-6 xl:grid-cols-[1.25fr_0.75fr]">
      <Card className="p-5 sm:p-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Agreement editor</p>
            <h2 className="mt-1 font-display text-2xl">Version {draftVersion?.version_number ?? "new"}</h2>
          </div>
          <Badge tone="info">Draft — review before sending</Badge>
        </div>
        <p className="mt-4 rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-900">
          This workspace helps document project terms. It is not legal advice, and no draft is automatically approved or legally binding.
        </p>

        <div className="mt-6 space-y-6">
          <TextArea label="Summary" value={draft.summary} onChange={(value) => setValue("summary", value)} />
          <TextArea label="Objective" value={draft.objective} onChange={(value) => setValue("objective", value)} />

          {/* Scope Items */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-[0.1em] text-ink-800">
                Scope Items ({draft.scopeItems.length})
              </h3>
              <Button
                className="min-h-8 px-3 text-xs"
                disabled={busy}
                onClick={() => setValue("scopeItems", addScopeItem(draft.scopeItems))}
                type="button"
                variant="secondary"
              >
                <Plus className="mr-1" size={14} /> Add item
              </Button>
            </div>

            {draft.scopeItems.map((scope, index) => (
              <div className="space-y-3 rounded-xl border border-ink-200 bg-ink-50/50 p-4" key={scope.id || index}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-teal-800">Item #{index + 1}</span>
                  {draft.scopeItems.length > 1 && (
                    <Button
                      className="min-h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={() => setValue("scopeItems", removeScopeItem(draft.scopeItems, index))}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="mr-1 text-red-600" size={13} />
                      <span className="text-red-600">Remove</span>
                    </Button>
                  )}
                </div>

                <label className="block text-sm font-semibold text-ink-800">
                  Item Title
                  <input
                    className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                    onChange={(e) => setValue("scopeItems", updateScopeItem(draft.scopeItems, index, { title: e.target.value }))}
                    value={scope.title}
                  />
                </label>

                <TextArea
                  label="Description"
                  onChange={(val) => setValue("scopeItems", updateScopeItem(draft.scopeItems, index, { description: val }))}
                  value={scope.description}
                />

                <TextArea
                  label="Deliverables (one per line)"
                  onChange={(val) => setValue("scopeItems", updateScopeItem(draft.scopeItems, index, { deliverables: lines(val) }))}
                  value={scope.deliverables.join("\n")}
                />

                <TextArea
                  label="Acceptance Criteria (one per line)"
                  onChange={(val) => setValue("scopeItems", updateScopeItem(draft.scopeItems, index, { acceptanceCriteria: lines(val) }))}
                  value={scope.acceptanceCriteria.join("\n")}
                />
              </div>
            ))}
          </div>

          <TextArea label="Exclusions (one per line)" value={draft.exclusions.join("\n")} onChange={(value) => setValue("exclusions", lines(value))} />
          <TextArea label="Payment terms (one per line)" value={draft.paymentTerms.join("\n")} onChange={(value) => setValue("paymentTerms", lines(value))} />
          <TextArea label="Revision policy (one per line)" value={draft.revisionPolicy.join("\n")} onChange={(value) => setValue("revisionPolicy", lines(value))} />
          <TextArea label="Change request procedure (one per line)" value={draft.changeProcess.join("\n")} onChange={(value) => setValue("changeProcess", lines(value))} />
          <TextArea label="Open questions (one per line)" value={draft.openQuestions.join("\n")} onChange={(value) => setValue("openQuestions", lines(value))} />

          {/* Milestones */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-[0.1em] text-ink-800">
                Milestones ({draft.milestones.length})
              </h3>
              <Button
                className="min-h-8 px-3 text-xs"
                disabled={busy}
                onClick={() => setValue("milestones", addMilestone(draft.milestones, draft.milestones[0]?.currency ?? "USD"))}
                type="button"
                variant="secondary"
              >
                <Plus className="mr-1" size={14} /> Add milestone
              </Button>
            </div>

            {draft.milestones.map((milestone, index) => (
              <div className="space-y-3 rounded-xl border border-ink-200 bg-ink-50/50 p-4" key={milestone.id || index}>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-bold uppercase tracking-wider text-teal-800">Milestone #{index + 1}</span>
                  {draft.milestones.length > 1 && (
                    <Button
                      className="min-h-7 px-2 text-xs"
                      disabled={busy}
                      onClick={() => setValue("milestones", removeMilestone(draft.milestones, index))}
                      type="button"
                      variant="ghost"
                    >
                      <Trash2 className="mr-1 text-red-600" size={13} />
                      <span className="text-red-600">Remove</span>
                    </Button>
                  )}
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm font-semibold text-ink-800">
                    Milestone Title
                    <input
                      className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                      onChange={(e) => setValue("milestones", updateMilestone(draft.milestones, index, { title: e.target.value }))}
                      value={milestone.title}
                    />
                  </label>
                  <label className="text-sm font-semibold text-ink-800">
                    Amount (minor units) · {milestone.currency}
                    <input
                      className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                      min="1"
                      onChange={(e) => setValue("milestones", updateMilestone(draft.milestones, index, { amountMinor: Math.max(1, Number(e.target.value)) }))}
                      type="number"
                      value={milestone.amountMinor}
                    />
                  </label>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm font-semibold text-ink-800">
                    Due Date
                    <input
                      className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                      onChange={(e) => setValue("milestones", updateMilestone(draft.milestones, index, { dueDate: e.target.value || null }))}
                      type="date"
                      value={milestone.dueDate ?? ""}
                    />
                  </label>
                  <label className="text-sm font-semibold text-ink-800">
                    Description
                    <input
                      className="mt-1 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2 text-sm font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                      onChange={(e) => setValue("milestones", updateMilestone(draft.milestones, index, { description: e.target.value }))}
                      value={milestone.description}
                    />
                  </label>
                </div>
              </div>
            ))}
          </div>
        </div>

        {notice && <Notice message={notice} />}

        <div className="mt-7 flex flex-wrap gap-3">
          <Button disabled={busy} onClick={save}>Save draft</Button>
          <Button
            disabled={busy || !isClientVerified}
            onClick={sendForReview}
            variant="secondary"
            title={!isClientVerified ? "Client email must be verified before sending for review" : undefined}
          >
            <Send className="mr-2" size={16} />Send for client review
          </Button>
        </div>

        {!isClientVerified && (
          <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50/80 p-4 text-xs text-amber-950">
            <p className="font-bold text-amber-900">Client Email Verification Pending</p>
            <p className="mt-1 text-amber-800">
              The client ({clientEmail || "client"}) has not verified their email address yet. Sending for review is disabled until the client completes email verification.
            </p>
          </div>
        )}

        {reviewUrl && (
          <div className="mt-5 rounded-xl border border-teal-600/20 bg-teal-50 p-4">
            <p className="text-sm font-semibold text-teal-800">Secure review link — share it privately</p>
            <div className="mt-2 flex gap-2">
              <input aria-label="Secure agreement review link" className="min-w-0 flex-1 rounded-lg border border-teal-600/20 bg-white p-2 text-xs" readOnly value={reviewUrl} />
              <Button aria-label="Copy review link" onClick={() => navigator.clipboard.writeText(reviewUrl)} variant="secondary">
                <Copy size={16} />
              </Button>
            </div>
          </div>
        )}
      </Card>

      <aside className="space-y-5">
        <Card className="p-5">
          <div className="flex items-center gap-2">
            <Eye className="text-teal-700" size={18} />
            <h3 className="font-display text-xl">Live preview</h3>
          </div>
          <p className="mt-4 font-semibold text-ink-900">{draft.summary}</p>
          <p className="mt-3 text-sm leading-6 text-ink-700">{draft.objective}</p>

          <h4 className="mt-5 text-sm font-bold text-ink-900">Scope Items ({draft.scopeItems.length})</h4>
          <div className="mt-2 space-y-2">
            {draft.scopeItems.map((s, idx) => (
              <div className="border-l-2 border-teal-600/30 pl-2 text-sm text-ink-700" key={s.id || idx}>
                <p className="font-medium text-ink-900">{s.title || `Scope item ${idx + 1}`}</p>
                {s.description && <p className="text-xs leading-5 text-ink-600">{s.description}</p>}
                {s.deliverables.length > 0 && <p className="mt-0.5 text-xs text-ink-500">{s.deliverables.length} deliverable(s)</p>}
              </div>
            ))}
          </div>

          <h4 className="mt-5 text-sm font-bold text-ink-900">Milestones ({draft.milestones.length})</h4>
          <div className="mt-2 space-y-2">
            {draft.milestones.map((m, idx) => (
              <div className="flex justify-between border-l-2 border-teal-600/30 pl-2 text-sm text-ink-700" key={m.id || idx}>
                <span>{m.title || `Milestone ${idx + 1}`}</span>
                <span className="font-medium text-ink-900">{m.amountMinor.toLocaleString()} {m.currency}</span>
              </div>
            ))}
          </div>

          <div className="mt-4 flex justify-between border-t border-ink-100 pt-3 text-sm font-bold text-ink-900">
            <span>Total allocation:</span>
            <span>
              {draft.milestones.reduce((acc, m) => acc + m.amountMinor, 0).toLocaleString()} {draft.milestones[0]?.currency ?? ""}
            </span>
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="font-display text-xl">Version history</h3>
          <ol className="mt-4 space-y-3">
            {versions.map((version) => (
              <li className="border-l-2 border-ink-200 pl-3" key={version.id}>
                <p className="text-sm font-bold">
                  Version {version.version_number}{" "}
                  <span className="font-normal text-ink-700">· {version.status.replaceAll("_", " ")}</span>
                </p>
                <p className="mt-1 text-xs text-ink-700">{new Date(version.created_at).toLocaleString()}</p>
              </li>
            ))}
          </ol>
        </Card>
      </aside>
    </div>
  );
}

function TextArea({ label, value, onChange }: { label: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="block text-sm font-semibold text-ink-800">
      {label}
      <textarea
        className="mt-2 min-h-24 w-full rounded-xl border border-ink-200 p-3 font-normal outline-none focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
        onChange={(event) => onChange(event.target.value)}
        value={value}
      />
    </label>
  );
}

function Notice({ message }: { message: string }) {
  return <p aria-live="polite" className="mt-5 rounded-xl bg-ink-50 p-3 text-sm text-ink-700">{message}</p>;
}

