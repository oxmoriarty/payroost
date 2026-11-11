import { NextResponse } from "next/server";
import { z } from "zod";
import { authenticatePortalRequest } from "@/features/scope-changes/portal-auth";
import { apiError } from "@/lib/http";

const NO_STORE = { "Cache-Control": "no-store" } as const;
const uuidSchema = z.string().uuid();

const reviewDeliverableSchema = z.object({
  action: z.enum(["ACCEPT", "REQUEST_REVISION"]),
  note: z.string().trim().max(2000).optional().default(""),
});

const IN_FLIGHT_PAYMENT_STATUSES = [
  "ORDER_CREATING",
  "ORDER_CREATED",
  "BUYER_APPROVED",
  "CAPTURING",
  "RECONCILING",
  "RECONCILIATION_REQUIRED",
];

export async function POST(
  request: Request,
  context: { params: Promise<{ token: string; milestoneId: string }> },
) {
  const { token, milestoneId } = await context.params;
  if (!uuidSchema.safeParse(milestoneId).success) {
    return apiError("VALIDATION_ERROR", 400, NO_STORE);
  }

  const portalAuth = await authenticatePortalRequest({
    request,
    rawToken: token,
    rateLimitPrefix: "portal-milestone-review",
    limit: 20,
    windowMs: 900_000,
  });

  if (!portalAuth.ok) {
    return portalAuth.response;
  }

  let bodyRaw: unknown;
  try {
    const bodyText = await request.text();
    if (!bodyText || bodyText.trim().length === 0) {
      return apiError("VALIDATION_ERROR", 400, NO_STORE);
    }
    bodyRaw = JSON.parse(bodyText);
  } catch {
    return apiError("INVALID_JSON", 400, NO_STORE);
  }

  const parsed = reviewDeliverableSchema.safeParse(bodyRaw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: parsed.error.issues[0]?.message ?? "Invalid milestone review payload.",
      },
      { status: 400, headers: NO_STORE },
    );
  }

  if (parsed.data.action === "REQUEST_REVISION" && parsed.data.note.trim().length < 3) {
    return NextResponse.json(
      {
        error: "VALIDATION_ERROR",
        message: "Please provide revision notes (at least 3 characters) explaining what needs changes.",
      },
      { status: 400, headers: NO_STORE },
    );
  }

  const { serviceClient, projectId, clientEmail } = portalAuth;

  try {
    const { data: milestoneRow, error: milestoneError } = await serviceClient
      .from("milestones")
      .select("id, project_id, title, currency, amount_minor, status")
      .eq("id", milestoneId)
      .eq("project_id", projectId)
      .maybeSingle();

    if (milestoneError) {
      return apiError("DATABASE_ERROR", 500, NO_STORE);
    }

    const milestone = milestoneRow as {
      id: string;
      project_id: string;
      title: string;
      currency: string;
      amount_minor: number;
      status: string;
    } | null;

    if (!milestone) {
      return apiError("NOT_FOUND", 404, NO_STORE);
    }

    if (milestone.status !== "SUBMITTED") {
      return NextResponse.json(
        {
          error: "MILESTONE_NOT_SUBMITTED",
          message:
            "Deliverables must be in SUBMITTED state before the client can accept them or request revisions.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    // Check read-only payment state before allowing status transitions
    const { data: intents, error: intentsError } = await serviceClient
      .from("payment_intents")
      .select("id, status")
      .eq("milestone_id", milestoneId)
      .eq("project_id", projectId);

    if (intentsError) {
      return apiError("DATABASE_ERROR", 500, NO_STORE);
    }

    const intentList = (intents ?? []) as Array<{ id: string; status: string }>;
    const hasInFlightPayment = intentList.some((intent) =>
      IN_FLIGHT_PAYMENT_STATUSES.includes(intent.status),
    );

    if (hasInFlightPayment) {
      return NextResponse.json(
        {
          error: "PAYMENT_OPERATION_IN_PROGRESS",
          message:
            "A PayPal payment attempt or verification is currently active for this milestone. Wait for confirmation or cancel checkout before changing deliverable review status.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    let isPaid = intentList.some((intent) => intent.status === "COMPLETED");
    if (!isPaid && intentList.length > 0) {
      const { data: captures, error: captureError } = await serviceClient
        .from("payment_transactions")
        .select("id")
        .in(
          "payment_intent_id",
          intentList.map((i) => i.id),
        )
        .eq("status", "COMPLETED")
        .eq("transaction_type", "CAPTURE");

      if (captureError) {
        return apiError("DATABASE_ERROR", 500, NO_STORE);
      }

      isPaid = Boolean(captures && captures.length > 0);
    }

    // Enforce R4 checkout contract boundary cleanly (Decision #2):
    // Do not allow accepting an unpaid USD milestone while R4 PayPal checkout requires
    // status IN ('APPROVED', 'IN_PROGRESS', 'SUBMITTED').
    if (
      parsed.data.action === "ACCEPT" &&
      milestone.currency === "USD" &&
      milestone.amount_minor > 0 &&
      !isPaid
    ) {
      return NextResponse.json(
        {
          error: "PAYMENT_REQUIRED_BEFORE_ACCEPTANCE",
          message:
            "This USD milestone is unpaid. The current PayPal checkout flow cannot initiate payment once a milestone becomes ACCEPTED. Complete PayPal payment while it remains SUBMITTED, or request revisions.",
        },
        { status: 409, headers: NO_STORE },
      );
    }

    const nextStatus = parsed.data.action === "ACCEPT" ? "ACCEPTED" : "CHANGES_REQUESTED";

    const { data: updated, error: updateError } = await serviceClient
      .from("milestones")
      .update({ status: nextStatus })
      .eq("id", milestoneId)
      .eq("project_id", projectId)
      .eq("status", "SUBMITTED")
      .select("id, status, updated_at")
      .maybeSingle();

    if (updateError) {
      return apiError("MILESTONE_UPDATE_FAILED", 500, NO_STORE);
    }

    if (!updated) {
      return apiError("MILESTONE_NOT_SUBMITTED", 409, NO_STORE);
    }

    const note = parsed.data.note.trim() || null;

    await serviceClient.from("activity_events").insert({
      project_id: projectId,
      actor_user_id: null,
      actor_label: `Client (${clientEmail})`,
      event_type:
        parsed.data.action === "ACCEPT" ? "milestone.accepted" : "milestone.revision_requested",
      summary:
        parsed.data.action === "ACCEPT"
          ? `Accepted deliverables for "${milestone.title}"`
          : `Requested revisions on "${milestone.title}"`,
      metadata: {
        milestoneId: milestone.id,
        milestoneTitle: milestone.title,
        previousStatus: "SUBMITTED",
        nextStatus,
        feedbackNote: note,
      },
    });

    return NextResponse.json({ data: updated }, { headers: NO_STORE });
  } catch {
    return apiError("INTERNAL_ERROR", 500, NO_STORE);
  }
}
