import type { StructuredBrief } from "./schema";

/**
 * Formats a StructuredBrief into clean, readable markdown suitable for the project brief field or documentation.
 */
export function formatBriefToMarkdown(brief: StructuredBrief): string {
  const sections: string[] = [];

  sections.push(`# ${brief.title}\n\n${brief.summary}`);

  if (brief.objectives.length > 0) {
    sections.push(`## Objectives\n${brief.objectives.map((o) => `- ${o}`).join("\n")}`);
  }

  if (brief.deliverables.length > 0) {
    sections.push(`## Deliverables\n${brief.deliverables.map((d) => `- ${d}`).join("\n")}`);
  }

  if (brief.functionalRequirements.length > 0) {
    sections.push(`## Functional Requirements\n${brief.functionalRequirements.map((f) => `- ${f}`).join("\n")}`);
  }

  if (brief.nonFunctionalRequirements.length > 0) {
    sections.push(`## Non-Functional Requirements\n${brief.nonFunctionalRequirements.map((nf) => `- ${nf}`).join("\n")}`);
  }

  if (brief.scopeInclusions.length > 0) {
    sections.push(`## Scope Inclusions\n${brief.scopeInclusions.map((s) => `- ${s}`).join("\n")}`);
  }

  if (brief.scopeExclusions.length > 0) {
    sections.push(`## Scope Exclusions\n${brief.scopeExclusions.map((e) => `- ${e}`).join("\n")}`);
  }

  if (brief.assumptions.length > 0) {
    sections.push(`## Assumptions (Unconfirmed)\n${brief.assumptions.map((a) => `- ${a}`).join("\n")}`);
  }

  if (brief.constraints.length > 0) {
    sections.push(`## Constraints\n${brief.constraints.map((c) => `- ${c}`).join("\n")}`);
  }

  if (brief.dependencies.length > 0) {
    sections.push(`## Dependencies\n${brief.dependencies.map((d) => `- ${d}`).join("\n")}`);
  }

  sections.push(`## Timeline Expectations\n${brief.timelineExpectations ? brief.timelineExpectations : "Not specified by client."}`);

  if (brief.risks.length > 0) {
    sections.push(`## Identified Risks\n${brief.risks.map((r) => `- ${r}`).join("\n")}`);
  }

  if (brief.openQuestions.length > 0) {
    sections.push(`## Open Questions & Clarifications Needed\n${brief.openQuestions.map((q) => `- ${q}`).join("\n")}`);
  }

  return sections.join("\n\n");
}
