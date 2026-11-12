# Payroost — UX/UI Specification

## 1. Brand direction

**Brand personality:** calm, dependable, modern, clear, professional.  
**Product category:** freelance business / project finance SaaS.  
**Avoid:** crypto aesthetics, loud gradients, excessive glassmorphism, playful cartoon visuals, dense admin templates, fake banking balances, and decorative charts with no meaning.

### Visual system
- Primary: deep navy / ink.
- Accent: restrained teal or vivid blue for primary actions.
- Background: warm near-white / very light cool gray.
- Surface: white cards with subtle borders.
- Text: high-contrast charcoal; secondary muted slate.
- Success: accessible green; warning: amber; error: red.
- Use one consistent spacing scale and 8px rhythm.
- Rounded corners: 10–14px, not pill-shaped everything.
- Shadows: minimal and purposeful.
- Typography: Inter, Geist, or another clean sans-serif with clear hierarchy.

Codex should define design tokens as CSS variables and use them consistently. Do not use arbitrary one-off colours.

## 2. Information architecture

Authenticated app:
- Overview
- Projects
- Agreements (can be within project detail)
- Activity
- Settings

Project detail tabs:
- Overview
- Agreement
- Milestones & payments
- Change requests
- Activity

Public client pages:
- Agreement review
- Milestone payment

## 3. Required screens

### A. Marketing / entry
- Product name and concise value proposition.
- Primary CTA: Get started.
- Secondary CTA: View demo (if demo data is available).
- Three-step explanation: Agree scope → Track milestones → Pay with PayPal.
- Explicitly avoid claiming escrow or guaranteed protection.

### B. Sign in / sign up
- Minimal form.
- Clear validation.
- Password visibility toggle if password auth.
- Loading and error states.
- No fake social login buttons.

### C. Dashboard
Top area:
- Greeting and **New project** primary CTA.
- Summary cards: Active projects, Awaiting approval, Payments pending, Completed projects.
- Recent projects table/list with project, client, status, total, next milestone, updated date.
- Recent activity.
- Empty state with one obvious action.

Do not show total "money secured" or wallet balance.

### D. Create project
Use a focused stepper or single well-structured form:
1. Project details and client.
2. Brief, deliverables, exclusions.
3. Fee, currency, dates.
4. Generate agreement.

Show AI generation progress and allow manual continuation if AI fails.

### E. Agreement editor
- Left/main content: summary, scope, deliverables, exclusions, acceptance criteria, responsibilities, timeline, payment terms.
- Right/sticky panel: project fee, milestone allocation, open questions, draft status.
- Editable sections with clear save state.
- AI-generated content badge.
- "Review before sending" checklist.
- Send to client only after validation.
- Never make AI draft look pre-approved.

### F. Client review page
- Branded, uncluttered, mobile-friendly.
- Project title, freelancer identity, agreement version/date.
- Plain-language scope and deliverables.
- Exclusions and assumptions.
- Milestone/payment schedule.
- Buttons: Approve agreement; Request changes.
- Require explicit confirmation before approval.
- Show the approved version and timestamp after success.
- No client account required for MVP if secure token is used.

### G. Project workspace
Header:
- Project title, client, status, total fee.
- Primary action based on state.

Content:
- Progress summary.
- Agreement status/version.
- Milestone timeline/list.
- AI scope checker panel.
- Recent activity.

### H. Milestones & payment
Each milestone card:
- Title and description.
- Due date.
- Amount/currency.
- Status.
- Deliverables/acceptance criteria.
- Payment CTA only when eligible.
- Payment receipt/reference after verified capture.

Milestone payment page:
- Project and milestone summary.
- Exact amount and currency.
- PayPal button.
- Sandbox disclosure.
- Clear cancel/failure/success states.
- No false "paid" state while waiting for server confirmation.

### I. Scope-change analysis
- Large text area: "Describe the new request".
- Button: Analyse against agreement.
- Result panel with classification badge.
- Matched scope items and exclusions as evidence.
- Additional work and likely impact.
- Confidence/uncertainty explained in plain language.
- Actions: Edit request; Create change request; Dismiss.
- Never auto-create or charge.

### J. Change request review
- Original approved scope vs proposed addition.
- AI analysis clearly separated from human proposal.
- Freelancer enters proposed amount/time.
- Client sees and approves/rejects.
- Approval creates a new agreement version and optional milestone.

### K. Activity
Chronological, readable events. Include who acted and when. Avoid exposing internal technical metadata.

## 4. Interaction states

Every primary page/component needs:
- Loading/skeleton
- Empty
- Validation error
- Network/server error with retry
- Success confirmation
- Disabled/ineligible state with explanation

Use toast notifications for brief feedback, not as the only place important information appears.

## 5. Responsive behaviour

- Mobile-first.
- Desktop sidebar may collapse to a bottom/mobile menu.
- Tables become stacked cards on small screens.
- Sticky side panels become inline sections on mobile.
- Checkout and approval CTAs must remain easy to reach.
- Avoid horizontal overflow at 360px.

## 6. Accessibility

- Semantic HTML.
- Keyboard-accessible dialogs, menus, tabs, and forms.
- Visible focus states.
- Labels and descriptions for every input.
- Correct heading hierarchy.
- Sufficient text contrast.
- Do not communicate status using colour alone.
- Respect reduced-motion preference.

## 7. UX copy principles

Use short, direct, human language.
Prefer:
- "Agreement awaiting approval"
- "Payment confirmed"
- "Potential scope change"
- "Review suggested changes"

Avoid:
- "Funds secured"
- "Escrow protected"
- "AI has determined the client is wrong"
- "Guaranteed payment"
- "Legally binding AI contract"

## 8. Quality bar

The app should look like a credible early-stage SaaS product. Prioritise hierarchy, whitespace, alignment, consistent controls, and complete states over visual gimmicks. Use realistic seeded data. Do not ship placeholder charts, lorem ipsum, dead buttons, or non-functional menu items.
