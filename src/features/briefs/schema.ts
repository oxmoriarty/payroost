import { z } from "zod";

const briefLongString = z.string().trim().max(3000, "Text exceeds maximum length of 3000 characters");

/**
 * Normalizes string arrays: transforms nullish values to empty arrays and filters empty entries.
 */
const stringListSchema = (maxItems = 30) =>
  z
    .array(z.string().trim().max(1000))
    .max(maxItems, `List exceeds maximum limit of ${maxItems} items`)
    .nullish()
    .transform((items) => (Array.isArray(items) ? items.filter((item) => item.length > 0) : []));

/**
 * Strongly typed Zod schema representing an AI-structured, reviewable project brief.
 * Designed for Gemini structured JSON output and rigorous client-side editing.
 */
export const structuredBriefSchema = z.object({
  title: z
    .string()
    .trim()
    .min(2, "Project title must be at least 2 characters")
    .max(140, "Project title cannot exceed 140 characters"),
  summary: briefLongString.min(10, "Project summary must be at least 10 characters"),
  objectives: stringListSchema(20),
  functionalRequirements: stringListSchema(30),
  nonFunctionalRequirements: stringListSchema(30),
  deliverables: stringListSchema(30),
  scopeInclusions: stringListSchema(30),
  scopeExclusions: stringListSchema(30),
  assumptions: stringListSchema(30),
  constraints: stringListSchema(30),
  dependencies: stringListSchema(30),
  timelineExpectations: z
    .string()
    .trim()
    .max(1000, "Timeline expectations cannot exceed 1000 characters")
    .nullish()
    .transform((val) => (val && val.length > 0 ? val : null)),
  risks: stringListSchema(30),
  openQuestions: stringListSchema(30),
});

export type StructuredBrief = z.infer<typeof structuredBriefSchema>;

/**
 * Validation schema for the project brief structuring API endpoint.
 */
export const structureBriefRequestSchema = z
  .object({
    description: z
      .string()
      .trim()
      .min(10, "Project description must be at least 10 characters")
      .max(10000, "Project description cannot exceed 10,000 characters")
      .optional(),
    projectId: z.string().uuid("Invalid project ID format").optional(),
  })
  .refine(
    (data) => Boolean(data.description || data.projectId),
    {
      message: "Either a project description or a valid projectId must be provided.",
      path: ["description"],
    }
  );

export type StructureBriefRequest = z.infer<typeof structureBriefRequestSchema>;
