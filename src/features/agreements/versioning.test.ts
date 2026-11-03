import { describe, expect, it } from "vitest";
import { agreementDraftSchema } from "@/features/agreements/schema";
import { agreementContentHash, manualAgreementDraft } from "@/features/agreements/versioning";

describe("agreementContentHash", () => {
  const baseDraft = manualAgreementDraft({
    title: "E-commerce Website",
    brief: "Detailed project brief for online store with cart and checkout Handover.",
    clientName: "Jordan Lee",
    currency: "USD",
    totalAmountMinor: 200000,
    endDate: "2026-12-31",
  });

  it("produces a 64-character SHA-256 hexadecimal hash", () => {
    const hash = agreementContentHash(baseDraft);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces identical hashes regardless of object key order (canonical serialization)", () => {
    const draftA = {
      ...baseDraft,
      summary: "Sample Summary",
      objective: "Sample Objective",
    };
    // Construct object with reversed keys
    const draftB = {
      warnings: draftA.warnings,
      openQuestions: draftA.openQuestions,
      disputeResolution: draftA.disputeResolution,
      terminationNotes: draftA.terminationNotes,
      changeProcess: draftA.changeProcess,
      revisionPolicy: draftA.revisionPolicy,
      paymentTerms: draftA.paymentTerms,
      freelancerResponsibilities: draftA.freelancerResponsibilities,
      clientResponsibilities: draftA.clientResponsibilities,
      timeline: draftA.timeline,
      milestones: draftA.milestones,
      exclusions: draftA.exclusions,
      scopeItems: draftA.scopeItems,
      objective: draftA.objective,
      summary: draftA.summary,
    };

    expect(agreementContentHash(draftA)).toBe(agreementContentHash(draftB));
  });

  it("changes hash when content is modified", () => {
    const hashOriginal = agreementContentHash(baseDraft);
    const modifiedDraft = {
      ...baseDraft,
      summary: "Altered summary text that must produce a distinct hash",
    };
    const hashModified = agreementContentHash(modifiedDraft);

    expect(hashModified).not.toBe(hashOriginal);
  });
});

describe("manualAgreementDraft", () => {
  it("produces a complete draft conforming strictly to agreementDraftSchema", () => {
    const draft = manualAgreementDraft({
      title: "Mobile App MVP",
      brief: "Cross-platform mobile application brief with user authentication and push notifications.",
      clientName: "Taylor Smith",
      currency: "EUR",
      totalAmountMinor: 500000,
      endDate: "2027-01-31",
    });

    const parsed = agreementDraftSchema.safeParse(draft);
    expect(parsed.success).toBe(true);

    if (parsed.success) {
      expect(parsed.data.milestones[0].amountMinor).toBe(500000);
      expect(parsed.data.milestones[0].currency).toBe("EUR");
      expect(parsed.data.milestones[0].dueDate).toBe("2027-01-31");
      expect(parsed.data.scopeItems).toHaveLength(1);
    }
  });
});
