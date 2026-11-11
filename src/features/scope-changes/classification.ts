import type {
  AiRawScopeChangeOutput,
  ScopeChangeOverallClassification,
} from "./schema";

/**
 * Canonical whitespace-insensitive normalization for comparing request text against its analyzed snapshot.
 */
export function normalizeChangeRequestText(text: string): string {
  return text.trim().replace(/\r\n/g, "\n");
}

/**
 * Deterministically derives overall scope-change classification and explicit audit criteria from
 * validated structured fields rather than arbitrary model confidence scores.
 */
export function deriveDeterministicClassification(
  analysis: Pick<
    AiRawScopeChangeOutput,
    | "changeSummary"
    | "affectedDeliverables"
    | "affectedMilestones"
    | "proposedChanges"
    | "financialImpact"
    | "timelineImpact"
    | "dependencyChanges"
    | "riskAssessment"
    | "unresolvedQuestions"
  >
): {
  overallClassification: ScopeChangeOverallClassification;
  classificationCriteria: string[];
} {
  const criteria: string[] = [];

  if (analysis.financialImpact.direction === "INSUFFICIENT_INFORMATION") {
    criteria.push("Financial impact cannot be responsibly estimated from current information.");
  }
  if (analysis.timelineImpact.classification === "CANNOT_BE_ESTIMATED") {
    criteria.push("Timeline impact cannot yet be estimated due to missing scheduling context.");
  }
  if (analysis.changeSummary.conflictsOrContradictions.length > 0) {
    criteria.push("Change request contains contradictions or conflicting requirements.");
  }

  if (criteria.length > 0) {
    return {
      overallClassification: "INSUFFICIENT_INFORMATION",
      classificationCriteria: criteria,
    };
  }

  const highCriteria: string[] = [];

  const lockedMilestonesCount = analysis.affectedMilestones.filter(
    (m) => m.isPaymentLinkedOrLocked
  ).length;
  if (lockedMilestonesCount > 0) {
    highCriteria.push(
      `Affects ${lockedMilestonesCount} approved or payment-linked milestone(s).`
    );
  }

  if (analysis.riskAssessment.some((r) => r.severity === "HIGH")) {
    highCriteria.push("Includes at least one HIGH severity technical or delivery risk.");
  }

  if (analysis.financialImpact.direction === "DECREASE") {
    highCriteria.push("Proposes a reduction to committed project budget/scope.");
  }

  if (
    analysis.financialImpact.direction === "INCREASE" &&
    analysis.financialImpact.existingAgreedBudgetMinor !== null &&
    analysis.financialImpact.proposedCostDeltaMinor !== null &&
    BigInt(analysis.financialImpact.proposedCostDeltaMinor) * 100n >=
      BigInt(analysis.financialImpact.existingAgreedBudgetMinor) * 20n
  ) {
    highCriteria.push("Proposed cost increase is 20% or more of the agreed budget.");
  }

  if (
    analysis.timelineImpact.classification === "POTENTIAL_EXTENSION" &&
    (analysis.timelineImpact.estimatedAdditionalDaysMax ?? 0) >= 14
  ) {
    highCriteria.push("Potential timeline extension of 14 days or more.");
  }

  if (
    analysis.proposedChanges.newDeliverables.length >= 3 ||
    analysis.proposedChanges.proposedNewMilestones.length >= 2 ||
    analysis.affectedMilestones.length >= 3
  ) {
    highCriteria.push("Broad multi-deliverable or multi-milestone structural scope impact.");
  }

  if (highCriteria.length > 0) {
    return {
      overallClassification: "HIGH",
      classificationCriteria: highCriteria,
    };
  }

  const moderateCriteria: string[] = [];
  if (analysis.financialImpact.direction === "INCREASE") {
    moderateCriteria.push("Proposes an incremental cost increase requiring mutual review.");
  }
  if (analysis.timelineImpact.classification === "POTENTIAL_EXTENSION") {
    moderateCriteria.push("Identifies a potential schedule extension.");
  }
  if (
    analysis.affectedDeliverables.some((d) => d.impactType !== "UNCHANGED_CONTEXT") ||
    analysis.affectedMilestones.length > 0 ||
    analysis.proposedChanges.newDeliverables.length > 0 ||
    analysis.proposedChanges.removedOrReplacedWork.length > 0
  ) {
    moderateCriteria.push("Modifies, adds, or replaces specific deliverables or milestones.");
  }
  if (
    analysis.dependencyChanges.length > 0 ||
    analysis.riskAssessment.some((r) => r.severity === "MEDIUM")
  ) {
    moderateCriteria.push("Introduces dependency changes or medium delivery risks.");
  }

  if (moderateCriteria.length > 0) {
    return {
      overallClassification: "MODERATE",
      classificationCriteria: moderateCriteria,
    };
  }

  return {
    overallClassification: "LOW",
    classificationCriteria: [
      "Clarification or minor adjustment with no budget change, schedule delay, or payment-linked milestone impact identified.",
    ],
  };
}
