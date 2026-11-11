import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { apiError } from "@/lib/http";
import {
  generateOperatorCsrfSecret,
  getOperatorCsrfCookieName,
  getOperatorCsrfCookieOptions,
} from "@/lib/security/operator-csrf";

export async function GET() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();

  if (error || !user) {
    return apiError("UNAUTHORIZED", 401);
  }

  const csrfToken = generateOperatorCsrfSecret();
  const cookieStore = await cookies();
  cookieStore.set(getOperatorCsrfCookieName(), csrfToken, getOperatorCsrfCookieOptions());

  return NextResponse.json({
    csrfToken,
  });
}
