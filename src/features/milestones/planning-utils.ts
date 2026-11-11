import type { AgreementDraft } from "@/features/agreements/schema";
import type { MilestonePlan, PlannedMilestone } from "@/features/milestones/schema";

/**
 * Reorders a milestone within a planned milestone list and updates 1-based positions
 * while pruning any dependencies that would no longer point to an earlier milestone.
 */
export function movePlannedMilestone(
  milestones: PlannedMilestone[],
  index: number,
  direction: "up" | "down"
): PlannedMilestone[] {
  const targetIndex = direction === "up" ? index - 1 : index + 1;
  if (
    index < 0 ||
    index >= milestones.length ||
    targetIndex < 0 ||
    targetIndex >= milestones.length
  ) {
    return milestones;
  }

  const reordered = [...milestones];
  const [moved] = reordered.splice(index, 1);
  reordered.splice(targetIndex, 0, moved);

  return normalizeMilestonePositionsAndDeps(reordered);
}

/**
 * Recomputes sequential 1..N positions and removes any self-references, missing IDs,
 * or dependencies that do not precede the milestone in sequence.
 */
export function normalizeMilestonePositionsAndDeps(
  milestones: PlannedMilestone[]
): PlannedMilestone[] {
  const positionById = new Map<string, number>();
  milestones.forEach((m, idx) => {
    positionById.set(m.id, idx + 1);
  });

  return milestones.map((m, idx) => {
    const position = idx + 1;
    const validDeps = m.dependsOn.filter((depId) => {
      if (depId === m.id) return false;
      const depPos = positionById.get(depId);
      return depPos !== undefined && depPos < position;
    });

    return {
      ...m,
      position,
      dependsOn: validDeps,
    };
  });
}

/**
 * Toggles a prerequisite dependency on an individual planned milestone,
 * permitting only earlier milestones in sequence to prevent cycles.
 */
export function toggleMilestoneDependency(
  milestones: PlannedMilestone[],
  milestoneIndex: number,
  prerequisiteId: string
): PlannedMilestone[] {
  const target = milestones[milestoneIndex];
  if (!target || prerequisiteId === target.id) return milestones;

  const prereq = milestones.find((m) => m.id === prerequisiteId);
  if (!prereq || prereq.position >= target.position) {
    return milestones;
  }

  const hasDep = target.dependsOn.includes(prerequisiteId);
  const nextDeps = hasDep
    ? target.dependsOn.filter((id) => id !== prerequisiteId)
    : [...target.dependsOn, prerequisiteId];

  return milestones.map((m, idx) =>
    idx === milestoneIndex ? { ...m, dependsOn: nextDeps } : m
  );
}

/**
 * Sums all assigned positive integer minor-unit amounts across planned milestones.
 */
export function sumAllocatedMinorUnits(milestones: ReadonlyArray<{ proposedAmountMinor: number | null }>): {
  allocatedMinor: number;
  unassignedCount: number;
} {
  let allocatedMinor = 0;
  let unassignedCount = 0;

  for (const m of milestones) {
    if (m.proposedAmountMinor === null || !Number.isInteger(m.proposedAmountMinor)) {
      unassignedCount += 1;
    } else {
      allocatedMinor += m.proposedAmountMinor;
    }
  }

  return { allocatedMinor, unassignedCount };
}

/**
 * Maps an edited/confirmed MilestonePlan item into AgreementDraft["milestones"] format.
 * Only intended for milestones whose positive minor-unit amount and currency have been confirmed.
 */
export function toAgreementMilestone(
  item: {
    id?: string;
    title: string;
    description: string;
    deliverables: string[];
    acceptanceCriteria: string[];
    amountMinor: number;
    currency: string;
    dueDate: string | null;
  },
  index: number
): AgreementDraft["milestones"][number] {
  return {
    id: item.id?.trim() || `milestone-${index + 1}`,
    title: item.title,
    description: item.description,
    amountMinor: item.amountMinor,
    currency: item.currency,
    dueDate: item.dueDate,
    deliverables: item.deliverables,
    acceptanceCriteria: item.acceptanceCriteria,
  };
}

/**
 * Computes plan-level totals from edited milestones without altering individual amounts.
 */
export function syncPlanSummaryFields(
  plan: MilestonePlan,
  milestones: PlannedMilestone[]
): MilestonePlan {
  const normalized = normalizeMilestonePositionsAndDeps(milestones);
  const { allocatedMinor, unassignedCount } = sumAllocatedMinorUnits(normalized);

  return {
    ...plan,
    milestoneCount: normalized.length,
    milestones: normalized,
    totalProposedAmountMinor:
      unassignedCount === normalized.length || allocatedMinor <= 0 ? null : allocatedMinor,
  };
}
