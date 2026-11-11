-- PayRoost Phase AI-5: Intelligent Scope-Change Analysis
-- Strictly additive migration on public.change_requests to persist validated AI impact
-- analysis snapshots separately from the original user request_text.
--
-- Invariants preserved:
-- 1. All existing change_requests rows remain valid with the new columns set to NULL.
-- 2. Original request_text remains untouched and strictly separated from ai_analysis JSON.
-- 3. Existing submit_public_review_with_otp RPC and RLS policies remain unchanged.
-- 4. No agreement_versions, milestones, payment_intents, or ledger tables are modified.

alter table public.change_requests
  add column if not exists ai_analysis jsonb,
  add column if not exists ai_analyzed_at timestamptz,
  add column if not exists ai_model text;

alter table public.change_requests
  drop constraint if exists change_requests_ai_analysis_metadata_check;

alter table public.change_requests
  add constraint change_requests_ai_analysis_metadata_check
  check (
    (
      ai_analysis is null
      and ai_analyzed_at is null
      and ai_model is null
    )
    or (
      ai_analysis is not null
      and jsonb_typeof(ai_analysis) = 'object'
      and ai_analyzed_at is not null
      and ai_model is not null
      and char_length(trim(ai_model)) between 1 and 120
    )
  );

create index if not exists change_requests_project_created_idx
  on public.change_requests(project_id, created_at desc);
