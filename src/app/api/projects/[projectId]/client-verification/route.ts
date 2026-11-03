import { NextResponse } from "next/server";
import { requireProjectOwner } from "@/features/projects/authorization";
import { createVerificationToken, hashVerificationToken } from "@/lib/security/tokens";
import { allowRequest } from "@/lib/security/rate-limit";
import { sendClientVerificationEmail } from "@/lib/email/provider";
import { apiError } from "@/lib/http";

export async function POST(_request: Request, context: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await context.params;

  if (!(await allowRequest(`client-verification:${projectId}`, 3, 600_000))) {
    return apiError("RATE_LIMITED", 429);
  }

  try {
    const { supabase, project } = await requireProjectOwner(projectId);

    if (project.client_email_verified_at) {
      return NextResponse.json({
        success: true,
        alreadyVerified: true,
        clientEmail: project.client_email,
      });
    }

    const verificationToken = createVerificationToken();
    const tokenHash = hashVerificationToken(verificationToken);
    const expiresAt = new Date(Date.now() + 86_400_000).toISOString();

    const { error: rpcError } = await supabase.rpc("create_client_email_verification", {
      p_project_id: project.id,
      p_token_hash: tokenHash,
      p_expires_at: expiresAt,
    });

    if (rpcError) {
      return apiError("VERIFICATION_REQUEST_FAILED", 500);
    }

    const delivery = await sendClientVerificationEmail({
      clientEmail: project.client_email,
      clientName: project.client_name,
      projectTitle: project.title,
      verificationToken,
    });

    if (!delivery.success) {
      return NextResponse.json({
        success: false,
        deliveryWarning: delivery.error,
        clientEmail: project.client_email,
      }, { status: 502 });
    }

    return NextResponse.json({
      success: true,
      clientEmail: project.client_email,
    });
  } catch {
    return apiError("FORBIDDEN", 403);
  }
}
