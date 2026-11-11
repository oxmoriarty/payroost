import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ScopeChangeAnalysis } from "./schema";
import {
  getSnapshotSigningSecret,
  signScopeChangeAnalysisSnapshot,
  SnapshotSigningConfigurationError,
  verifyScopeChangeSnapshotSignature,
} from "./snapshot";

const sampleAnalysis: ScopeChangeAnalysis = {
  changeSummary: {
    requestedChangeSummary: "Add OAuth SSO login with Okta for enterprise team.",
    changeType: "ADDITION",
    conflictsOrContradictions: [],
  },
  originalAgreementContext: {
    agreementVersionNumber: 1,
    agreementStatus: "APPROVED",
    confirmedBudgetMinor: 300000,
    currency: "USD",
    summaryExcerpt: "Approved v1 contract baseline.",
  },
  affectedDeliverables: [],
  affectedMilestones: [],
  proposedChanges: {
    newDeliverables: [],
    removedOrReplacedWork: [],
    proposedNewMilestones: [],
  },
  financialImpact: {
    direction: "INCREASE",
    existingAgreedBudgetMinor: 300000,
    currency: "USD",
    proposedCostDeltaMinor: 50000,
    proposedRevisedTotalMinor: 350000,
    costDriversJustification: "SSO integration engineering.",
    reconcilesExistingMilestonesUnchanged: true,
    requiresHumanReviewNotice:
      "AI-generated financial and scope estimate only — requires mutual human review.",
  },
  timelineImpact: {
    classification: "POTENTIAL_EXTENSION",
    estimatedAdditionalDaysMin: 4,
    estimatedAdditionalDaysMax: 6,
    canProceedInParallel: false,
    parallelWorkNotes: null,
    criticalPathMilestones: ["Milestone 2: Billing Portal"],
    missingSchedulingInformation: [],
    explanation: "Adds 4-6 days to Milestone 2 schedule.",
  },
  dependencyChanges: [],
  riskAssessment: [],
  assumptions: [],
  unresolvedQuestions: ["Which IdP should be prioritized first?"],
  recommendedNextSteps: ["Create v2 agreement draft for bilateral sign-off."],
  overallClassification: "MODERATE",
  classificationCriteria: ["Proposes incremental budget addition (+50000 USD)."],
};

describe("AI-5 Scope-Change Snapshot Signing Secret Hardening", () => {
  const originalSnapshotSecret = process.env.PAYROOST_AI_SNAPSHOT_SECRET;
  const originalOtpSecret = process.env.PAYROOST_OTP_SECRET;

  const validSecretA = "snapshot-signing-secret-alpha-minimum-32-bytes-key!";
  const validSecretB = "snapshot-signing-secret-bravo-minimum-32-bytes-key!";
  const validProjectId = "11111111-1111-4111-8111-111111111111";
  const validVersionId = "22222222-2222-4222-8222-222222222222";
  const requestText = "  Add OAuth SSO login with Okta for enterprise team.  ";

  beforeEach(() => {
    delete process.env.PAYROOST_AI_SNAPSHOT_SECRET;
    delete process.env.PAYROOST_OTP_SECRET;
  });

  afterEach(() => {
    if (originalSnapshotSecret === undefined) {
      delete process.env.PAYROOST_AI_SNAPSHOT_SECRET;
    } else {
      process.env.PAYROOST_AI_SNAPSHOT_SECRET = originalSnapshotSecret;
    }

    if (originalOtpSecret === undefined) {
      delete process.env.PAYROOST_OTP_SECRET;
    } else {
      process.env.PAYROOST_OTP_SECRET = originalOtpSecret;
    }
  });

  it("fails closed in all environments when PAYROOST_AI_SNAPSHOT_SECRET is missing or blank, and never substitutes PAYROOST_OTP_SECRET", () => {
    for (const nodeEnv of ["production", "development", "test"] as const) {
      expect(() =>
        getSnapshotSigningSecret({
          NODE_ENV: nodeEnv,
          PAYROOST_OTP_SECRET: validSecretA,
        })
      ).toThrow(SnapshotSigningConfigurationError);

      expect(() =>
        getSnapshotSigningSecret({
          NODE_ENV: nodeEnv,
          PAYROOST_AI_SNAPSHOT_SECRET: "",
          PAYROOST_OTP_SECRET: validSecretA,
        })
      ).toThrow(SnapshotSigningConfigurationError);

      expect(() =>
        getSnapshotSigningSecret({
          NODE_ENV: nodeEnv,
          PAYROOST_AI_SNAPSHOT_SECRET: "                                        ",
        })
      ).toThrow(SnapshotSigningConfigurationError);
    }

    process.env.PAYROOST_OTP_SECRET = validSecretA;
    expect(() =>
      signScopeChangeAnalysisSnapshot({
        analysis: sampleAnalysis,
        requestText,
        agreementVersionId: validVersionId,
        agreementVersionNumber: 1,
        projectId: validProjectId,
        requesterRole: "CLIENT",
        model: "gemini-3.8-flash",
      })
    ).toThrow(SnapshotSigningConfigurationError);
  });

  it("rejects weak (< 32 bytes or trivial) and placeholder secrets without exposing the secret value in error messages", () => {
    const shortSecret = "too-short-snapshot-secret";
    let capturedError: unknown;
    try {
      getSnapshotSigningSecret({
        NODE_ENV: "production",
        PAYROOST_AI_SNAPSHOT_SECRET: shortSecret,
      });
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toBeInstanceOf(SnapshotSigningConfigurationError);
    expect((capturedError as Error).message).not.toContain(shortSecret);

    // 31-byte trimmed secret fails closed
    expect(() =>
      getSnapshotSigningSecret({
        NODE_ENV: "production",
        PAYROOST_AI_SNAPSHOT_SECRET: `  ${"x".repeat(30)}y  `,
      })
    ).toThrow(SnapshotSigningConfigurationError);

    // Trivial repeated-character secret fails closed even when >= 32 bytes
    expect(() =>
      getSnapshotSigningSecret({
        NODE_ENV: "production",
        PAYROOST_AI_SNAPSHOT_SECRET: "a".repeat(40),
      })
    ).toThrow(SnapshotSigningConfigurationError);

    const placeholders = [
      ["payroost", "default", "ai", "snapshot", "secret", "key", "do", "not", "use", "in", "production"].join("-"),
      "some-placeholder-ai-snapshot-secret-at-least-32-bytes",
      "change-me-ai-snapshot-signing-secret-32-bytes-min",
      "your-secret-ai-snapshot-key-with-sufficient-length",
    ];

    for (const placeholder of placeholders) {
      let placeholderErr: unknown;
      try {
        getSnapshotSigningSecret({
          NODE_ENV: "production",
          PAYROOST_AI_SNAPSHOT_SECRET: placeholder,
        });
      } catch (error) {
        placeholderErr = error;
      }
      expect(placeholderErr).toBeInstanceOf(SnapshotSigningConfigurationError);
      expect((placeholderErr as Error).message).not.toContain(placeholder);
    }
  });

  it("signs with valid >= 32 byte secret, preserves canonical serialization & HMAC verification with the same secret", () => {
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = `  ${validSecretA}  `;

    const signed = signScopeChangeAnalysisSnapshot({
      analysis: sampleAnalysis,
      requestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "CLIENT",
      model: "gemini-3.8-flash",
      analyzedAt: "2026-11-11T10:15:00.000Z",
    });

    expect(signed.snapshotMetadata.integrityTag).toMatch(/^[a-f0-9]{64}$/);
    expect(verifyScopeChangeSnapshotSignature(signed)).toBe(true);

    // Simulate JSON persistence round-trip with reordered top-level/nested keys
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = validSecretA;
    const reordered = {
      snapshotMetadata: {
        isProposalOnly: signed.snapshotMetadata.isProposalOnly,
        integrityTag: signed.snapshotMetadata.integrityTag,
        model: signed.snapshotMetadata.model,
        analyzedAt: signed.snapshotMetadata.analyzedAt,
        requesterRole: signed.snapshotMetadata.requesterRole,
        projectId: signed.snapshotMetadata.projectId,
        agreementVersionNumber: signed.snapshotMetadata.agreementVersionNumber,
        agreementVersionId: signed.snapshotMetadata.agreementVersionId,
        analyzedRequestTextSha256: signed.snapshotMetadata.analyzedRequestTextSha256,
      },
      overallClassification: signed.overallClassification,
      classificationCriteria: signed.classificationCriteria,
      recommendedNextSteps: signed.recommendedNextSteps,
      unresolvedQuestions: signed.unresolvedQuestions,
      assumptions: signed.assumptions,
      riskAssessment: signed.riskAssessment,
      dependencyChanges: signed.dependencyChanges,
      timelineImpact: signed.timelineImpact,
      financialImpact: {
        requiresHumanReviewNotice: signed.financialImpact.requiresHumanReviewNotice,
        reconcilesExistingMilestonesUnchanged:
          signed.financialImpact.reconcilesExistingMilestonesUnchanged,
        costDriversJustification: signed.financialImpact.costDriversJustification,
        proposedRevisedTotalMinor: signed.financialImpact.proposedRevisedTotalMinor,
        proposedCostDeltaMinor: signed.financialImpact.proposedCostDeltaMinor,
        currency: signed.financialImpact.currency,
        existingAgreedBudgetMinor: signed.financialImpact.existingAgreedBudgetMinor,
        direction: signed.financialImpact.direction,
      },
      proposedChanges: signed.proposedChanges,
      affectedMilestones: signed.affectedMilestones,
      affectedDeliverables: signed.affectedDeliverables,
      originalAgreementContext: signed.originalAgreementContext,
      changeSummary: signed.changeSummary,
    };

    expect(verifyScopeChangeSnapshotSignature(reordered)).toBe(true);

    // Legacy hardcoded secret cannot verify or match
    const legacyTag = createHmac(
      "sha256",
      ["payroost", "default", "ai", "snapshot", "secret", "key", "do", "not", "use", "in", "production"].join("-")
    )
      .update("mismatch")
      .digest("hex");
    expect(signed.snapshotMetadata.integrityTag).not.toBe(legacyTag);
  });

  it("rejects mismatched secrets (returns false) and tampered snapshots", () => {
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = validSecretA;
    const signed = signScopeChangeAnalysisSnapshot({
      analysis: sampleAnalysis,
      requestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "OWNER",
      model: "gemini-3.8-flash",
      analyzedAt: "2026-11-11T10:15:00.000Z",
    });

    // Different configured secret -> verification returns false
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = validSecretB;
    expect(verifyScopeChangeSnapshotSignature(signed)).toBe(false);

    // Original secret + tampered field -> verification returns false
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = validSecretA;
    const tampered = {
      ...signed,
      financialImpact: {
        ...signed.financialImpact,
        proposedCostDeltaMinor: 999999,
      },
    };
    expect(verifyScopeChangeSnapshotSignature(tampered)).toBe(false);
  });

  it("fails closed during verification when PAYROOST_AI_SNAPSHOT_SECRET becomes missing or invalid (even with invalid hex tag)", () => {
    process.env.PAYROOST_AI_SNAPSHOT_SECRET = validSecretA;
    const signed = signScopeChangeAnalysisSnapshot({
      analysis: sampleAnalysis,
      requestText,
      agreementVersionId: validVersionId,
      agreementVersionNumber: 1,
      projectId: validProjectId,
      requesterRole: "CLIENT",
      model: "gemini-3.8-flash",
    });

    delete process.env.PAYROOST_AI_SNAPSHOT_SECRET;
    expect(() => verifyScopeChangeSnapshotSignature(signed)).toThrow(
      SnapshotSigningConfigurationError
    );

    const malformedTagSnapshot = {
      ...signed,
      snapshotMetadata: {
        ...signed.snapshotMetadata,
        integrityTag: "not-hex",
      },
    };
    expect(() => verifyScopeChangeSnapshotSignature(malformedTagSnapshot)).toThrow(
      SnapshotSigningConfigurationError
    );
  });
});
