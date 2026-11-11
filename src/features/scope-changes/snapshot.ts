import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { normalizeChangeRequestText } from "./classification";
import type {
  ScopeChangeAnalysis,
  ScopeChangeRequesterRole,
  StoredScopeChangeAnalysis,
} from "./schema";

const HEX_64_REGEX = /^[a-f0-9]{64}$/i;

function getSnapshotSigningSecret(): string {
  return (
    process.env.PAYROOST_AI_SNAPSHOT_SECRET ||
    process.env.PAYROOST_OTP_SECRET ||
    "payroost-default-ai-snapshot-secret-key-do-not-use-in-production"
  );
}

/**
 * Recursively sorts object keys so canonical serialization remains invariant across
 * PostgreSQL jsonb storage or JSON transport roundtrips.
 */
function canonicalizeJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJsonValue);
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      sorted[key] = canonicalizeJsonValue(record[key]);
    }
    return sorted;
  }
  return value;
}

export function hashChangeRequestText(requestText: string): string {
  return createHash("sha256")
    .update(normalizeChangeRequestText(requestText), "utf8")
    .digest("hex");
}

function computeSnapshotHmac(params: {
  analysis: ScopeChangeAnalysis;
  analyzedRequestTextSha256: string;
  agreementVersionId: string;
  agreementVersionNumber: number;
  projectId: string;
  requesterRole: ScopeChangeRequesterRole;
  analyzedAt: string;
  model: string;
  isProposalOnly: true;
}): string {
  const canonicalPayload = JSON.stringify(canonicalizeJsonValue(params));
  return createHmac("sha256", getSnapshotSigningSecret())
    .update(canonicalPayload, "utf8")
    .digest("hex");
}

/**
 * Stamps a validated ScopeChangeAnalysis with cryptographic integrity binding to the exact
 * normalized request text, project ID, agreement version ID, requester role, and model.
 */
export function signScopeChangeAnalysisSnapshot(params: {
  analysis: ScopeChangeAnalysis;
  requestText: string;
  agreementVersionId: string;
  agreementVersionNumber: number;
  projectId: string;
  requesterRole: ScopeChangeRequesterRole;
  model: string;
  analyzedAt?: string;
}): StoredScopeChangeAnalysis {
  const analyzedAt = params.analyzedAt ?? new Date().toISOString();
  const analyzedRequestTextSha256 = hashChangeRequestText(params.requestText);
  const integrityTag = computeSnapshotHmac({
    analysis: params.analysis,
    analyzedRequestTextSha256,
    agreementVersionId: params.agreementVersionId,
    agreementVersionNumber: params.agreementVersionNumber,
    projectId: params.projectId,
    requesterRole: params.requesterRole,
    analyzedAt,
    model: params.model,
    isProposalOnly: true,
  });

  return {
    ...params.analysis,
    snapshotMetadata: {
      analyzedRequestTextSha256,
      agreementVersionId: params.agreementVersionId,
      agreementVersionNumber: params.agreementVersionNumber,
      projectId: params.projectId,
      requesterRole: params.requesterRole,
      analyzedAt,
      model: params.model,
      integrityTag,
      isProposalOnly: true,
    },
  };
}

/**
 * Timing-safe verification that a submitted AI analysis snapshot was issued by PayRoost for
 * the exact project, agreement version, requester role, and unmodified request text.
 */
export function verifyScopeChangeSnapshotSignature(
  snapshot: StoredScopeChangeAnalysis
): boolean {
  const { snapshotMetadata, ...analysis } = snapshot;

  if (!HEX_64_REGEX.test(snapshotMetadata.integrityTag)) {
    return false;
  }

  const expectedTag = computeSnapshotHmac({
    analysis,
    analyzedRequestTextSha256: snapshotMetadata.analyzedRequestTextSha256,
    agreementVersionId: snapshotMetadata.agreementVersionId,
    agreementVersionNumber: snapshotMetadata.agreementVersionNumber,
    projectId: snapshotMetadata.projectId,
    requesterRole: snapshotMetadata.requesterRole,
    analyzedAt: snapshotMetadata.analyzedAt,
    model: snapshotMetadata.model,
    isProposalOnly: snapshotMetadata.isProposalOnly,
  });

  const submittedBuf = Buffer.from(snapshotMetadata.integrityTag.toLowerCase(), "utf8");
  const expectedBuf = Buffer.from(expectedTag.toLowerCase(), "utf8");

  if (submittedBuf.length !== expectedBuf.length) {
    return false;
  }

  return timingSafeEqual(submittedBuf, expectedBuf);
}
