import { describe, it, expect } from "vitest";
import {
  structuredBriefSchema,
  structureBriefRequestSchema,
  type StructuredBrief,
} from "./schema";

describe("structuredBriefSchema", () => {
  const validSampleBrief: StructuredBrief = {
    title: "E-Commerce Apparel Store",
    summary: "Build an online storefront for client's clothing business with customer checkout.",
    objectives: ["Launch digital storefront", "Increase direct-to-consumer sales"],
    functionalRequirements: ["Product catalog browsing", "Shopping cart", "Customer authentication"],
    nonFunctionalRequirements: ["Mobile responsiveness", "Under 2 second page load"],
    deliverables: ["Next.js web application", "CMS integration", "Deployment documentation"],
    scopeInclusions: ["Frontend store", "Cart functionality", "Stripe checkout setup"],
    scopeExclusions: ["Inventory photography", "Ongoing fulfillment operations"],
    assumptions: ["Client will provide product imagery and descriptions"],
    constraints: ["Must run on Vercel and Supabase"],
    dependencies: ["Stripe account API keys provided by client"],
    timelineExpectations: "Target launch in 6 weeks",
    risks: ["Delay in receiving brand assets and catalog data"],
    openQuestions: ["Which shipping carrier APIs should be integrated?"],
  };

  it("validates a complete, valid structured brief", () => {
    const result = structuredBriefSchema.safeParse(validSampleBrief);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("E-Commerce Apparel Store");
      expect(result.data.deliverables).toHaveLength(3);
      expect(result.data.timelineExpectations).toBe("Target launch in 6 weeks");
    }
  });

  it("normalizes empty or nullish arrays to empty arrays", () => {
    const minimalBrief = {
      title: "Mobile App Redesign",
      summary: "Modernize existing iOS mobile app interface with updated branding.",
      objectives: null,
      functionalRequirements: undefined,
      nonFunctionalRequirements: [],
      deliverables: ["Figma prototypes"],
      scopeInclusions: null,
      scopeExclusions: undefined,
      assumptions: null,
      constraints: null,
      dependencies: null,
      timelineExpectations: null,
      risks: null,
      openQuestions: null,
    };

    const result = structuredBriefSchema.safeParse(minimalBrief);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.objectives).toEqual([]);
      expect(result.data.functionalRequirements).toEqual([]);
      expect(result.data.scopeInclusions).toEqual([]);
      expect(result.data.assumptions).toEqual([]);
      expect(result.data.openQuestions).toEqual([]);
      expect(result.data.timelineExpectations).toBeNull();
    }
  });

  it("normalizes empty string timeline expectations to null", () => {
    const briefWithEmptyTimeline = {
      ...validSampleBrief,
      timelineExpectations: "   ",
    };

    const result = structuredBriefSchema.safeParse(briefWithEmptyTimeline);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timelineExpectations).toBeNull();
    }
  });

  it("rejects briefs with missing or too short titles", () => {
    const invalidBrief = {
      ...validSampleBrief,
      title: "A",
    };

    const result = structuredBriefSchema.safeParse(invalidBrief);
    expect(result.success).toBe(false);
  });

  it("rejects briefs with title exceeding 140 characters", () => {
    const invalidBrief = {
      ...validSampleBrief,
      title: "A".repeat(141),
    };

    const result = structuredBriefSchema.safeParse(invalidBrief);
    expect(result.success).toBe(false);
  });

  it("rejects summaries under 10 characters", () => {
    const invalidBrief = {
      ...validSampleBrief,
      summary: "Too short",
    };

    const result = structuredBriefSchema.safeParse(invalidBrief);
    expect(result.success).toBe(false);
  });

  it("rejects summaries exceeding 3000 characters", () => {
    const invalidBrief = {
      ...validSampleBrief,
      summary: "X".repeat(3001),
    };

    const result = structuredBriefSchema.safeParse(invalidBrief);
    expect(result.success).toBe(false);
  });

  it("rejects arrays exceeding maximum allowed item count", () => {
    const tooManyDeliverables = Array.from({ length: 31 }, (_, i) => `Deliverable ${i + 1}`);
    const invalidBrief = {
      ...validSampleBrief,
      deliverables: tooManyDeliverables,
    };

    const result = structuredBriefSchema.safeParse(invalidBrief);
    expect(result.success).toBe(false);
  });

  it("filters out empty or whitespace-only items in string arrays", () => {
    const briefWithWhitespaceItems = {
      ...validSampleBrief,
      deliverables: ["Deliverable 1", "   ", "", "Deliverable 2"],
    };

    const result = structuredBriefSchema.safeParse(briefWithWhitespaceItems);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.deliverables).toEqual(["Deliverable 1", "Deliverable 2"]);
    }
  });

  it("rejects individual array items exceeding 1000 characters", () => {
    const invalidBrief = {
      ...validSampleBrief,
      deliverables: ["Valid deliverable", "L".repeat(1001)],
    };

    const result = structuredBriefSchema.safeParse(invalidBrief);
    expect(result.success).toBe(false);
  });
});

describe("structureBriefRequestSchema", () => {
  it("accepts valid description with at least 10 characters", () => {
    const result = structureBriefRequestSchema.safeParse({
      description: "Need an e-commerce website for our clothing brand with product catalog.",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid projectId without explicit description", () => {
    const result = structureBriefRequestSchema.safeParse({
      projectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });
    expect(result.success).toBe(true);
  });

  it("accepts both description and valid projectId", () => {
    const result = structureBriefRequestSchema.safeParse({
      description: "Refining requirements for mobile checkout integration.",
      projectId: "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    });
    expect(result.success).toBe(true);
  });

  it("rejects when neither description nor projectId is provided", () => {
    const result = structureBriefRequestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it("rejects descriptions under 10 characters", () => {
    const result = structureBriefRequestSchema.safeParse({
      description: "Short",
    });
    expect(result.success).toBe(false);
  });

  it("rejects descriptions exceeding 10,000 characters", () => {
    const result = structureBriefRequestSchema.safeParse({
      description: "Z".repeat(10001),
    });
    expect(result.success).toBe(false);
  });

  it("rejects malformed projectId UUIDs", () => {
    const result = structureBriefRequestSchema.safeParse({
      projectId: "not-a-valid-uuid",
      description: "Valid description here",
    });
    expect(result.success).toBe(false);
  });
});
