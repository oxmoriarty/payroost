import { describe, expect, it } from "vitest";
import {
  addMilestone,
  addScopeItem,
  removeMilestone,
  removeScopeItem,
  updateMilestone,
  updateScopeItem,
} from "@/features/agreements/agreement-editor";
import type { AgreementDraft } from "@/features/agreements/schema";

const sampleScopeItems: AgreementDraft["scopeItems"] = [
  {
    id: "scope-1",
    title: "Storefront Design",
    description: "Modern e-commerce UI design",
    deliverables: ["Figma prototypes", "Design tokens"],
    acceptanceCriteria: ["Mobile and desktop layouts approved"],
    assumptions: ["Client provides brand assets"],
  },
  {
    id: "scope-2",
    title: "Cart & Checkout Flow",
    description: "Shopping cart with state management",
    deliverables: ["Cart drawer", "Checkout form"],
    acceptanceCriteria: ["Cart persists across sessions"],
    assumptions: ["Payment gateway keys provided"],
  },
  {
    id: "scope-3",
    title: "Admin Dashboard",
    description: "Product management panel",
    deliverables: ["Product table", "Order list"],
    acceptanceCriteria: ["Admin can update inventory"],
    assumptions: [],
  },
];

const sampleMilestones: AgreementDraft["milestones"] = [
  {
    id: "m-1",
    title: "Design Approval",
    description: "Wireframes and prototypes",
    amountMinor: 40000,
    currency: "USD",
    dueDate: "2026-11-15",
    deliverables: ["Figma link"],
    acceptanceCriteria: ["Client signs off"],
  },
  {
    id: "m-2",
    title: "Frontend Build",
    description: "Next.js components and responsive layouts",
    amountMinor: 60000,
    currency: "USD",
    dueDate: "2026-12-01",
    deliverables: ["Vercel preview URL"],
    acceptanceCriteria: ["Lighthouse score >= 90"],
  },
  {
    id: "m-3",
    title: "Final QA & Handoff",
    description: "Testing and production deployment",
    amountMinor: 100000,
    currency: "USD",
    dueDate: "2026-12-15",
    deliverables: ["Repo transfer", "Documentation"],
    acceptanceCriteria: ["All test suites pass"],
  },
];

describe("AgreementEditor scope item helpers (data-loss regression)", () => {
  it("updates only the target scope item without mutating or dropping others", () => {
    const updated = updateScopeItem(sampleScopeItems, 1, {
      description: "Updated cart description",
      deliverables: ["Cart drawer v2"],
    });

    expect(updated).toHaveLength(3);
    // Modified item
    expect(updated[1].description).toBe("Updated cart description");
    expect(updated[1].deliverables).toEqual(["Cart drawer v2"]);
    expect(updated[1].title).toBe("Cart & Checkout Flow"); // Unmodified field in target item preserved

    // Untouched items completely preserved
    expect(updated[0]).toEqual(sampleScopeItems[0]);
    expect(updated[2]).toEqual(sampleScopeItems[2]);

    // Original array was not mutated in place
    expect(sampleScopeItems[1].description).toBe("Shopping cart with state management");
  });

  it("appends a new scope item while preserving all existing items", () => {
    const withNew = addScopeItem(sampleScopeItems, {
      title: "Analytics Integration",
      description: "PostHog setup",
    });

    expect(withNew).toHaveLength(4);
    expect(withNew.slice(0, 3)).toEqual(sampleScopeItems);
    expect(withNew[3].title).toBe("Analytics Integration");
    expect(withNew[3].description).toBe("PostHog setup");
  });

  it("removes only the selected scope item and preserves remaining items", () => {
    const removed = removeScopeItem(sampleScopeItems, 1);

    expect(removed).toHaveLength(2);
    expect(removed[0]).toEqual(sampleScopeItems[0]);
    expect(removed[1]).toEqual(sampleScopeItems[2]);
  });

  it("refuses to remove the last remaining scope item to preserve schema validity", () => {
    const single = [sampleScopeItems[0]];
    const attemptRemove = removeScopeItem(single, 0);

    expect(attemptRemove).toHaveLength(1);
    expect(attemptRemove[0]).toEqual(sampleScopeItems[0]);
  });
});

describe("AgreementEditor milestone helpers (data-loss regression)", () => {
  it("updates only the target milestone without mutating or dropping others", () => {
    const updated = updateMilestone(sampleMilestones, 0, {
      amountMinor: 50000,
      title: "Revised Design Phase",
    });

    expect(updated).toHaveLength(3);
    expect(updated[0].amountMinor).toBe(50000);
    expect(updated[0].title).toBe("Revised Design Phase");
    expect(updated[0].currency).toBe("USD"); // Unmodified field preserved

    // Remaining milestones untouched
    expect(updated[1]).toEqual(sampleMilestones[1]);
    expect(updated[2]).toEqual(sampleMilestones[2]);

    // Original array intact
    expect(sampleMilestones[0].amountMinor).toBe(40000);
  });

  it("appends a new milestone while preserving existing allocations", () => {
    const withNew = addMilestone(sampleMilestones, "USD", {
      title: "Post-Launch Support",
      amountMinor: 25000,
    });

    expect(withNew).toHaveLength(4);
    expect(withNew.slice(0, 3)).toEqual(sampleMilestones);
    expect(withNew[3].title).toBe("Post-Launch Support");
    expect(withNew[3].amountMinor).toBe(25000);
    expect(withNew[3].currency).toBe("USD");
  });

  it("removes only the selected milestone and preserves other milestones", () => {
    const removed = removeMilestone(sampleMilestones, 1);

    expect(removed).toHaveLength(2);
    expect(removed[0]).toEqual(sampleMilestones[0]);
    expect(removed[1]).toEqual(sampleMilestones[2]);
  });

  it("refuses to remove the last milestone to preserve schema validity", () => {
    const single = [sampleMilestones[0]];
    const attemptRemove = removeMilestone(single, 0);

    expect(attemptRemove).toHaveLength(1);
    expect(attemptRemove[0]).toEqual(sampleMilestones[0]);
  });
});
