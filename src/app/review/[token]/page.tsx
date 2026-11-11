import Link from "next/link";
import { AlertCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { hashReviewToken } from "@/lib/security/tokens";
import { PublicReviewView } from "@/features/agreements/public-review-view";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Brand, PublicBrandHeader } from "@/components/brand";

export default async function PublicReviewPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await contextParams(params);
  const supabase = await createClient();
  const tokenHash = hashReviewToken(token);

  const { data, error } = await supabase.rpc("get_public_review", {
    p_token_hash: tokenHash,
  });

  if (error || !data || (data as unknown[]).length !== 1) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 p-4">
        <Link className="mb-6 inline-flex items-center" href="/">
          <Brand size="sm" />
        </Link>
        <Card className="max-w-md w-full p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 text-amber-600">
            <AlertCircle className="h-7 w-7" />
          </div>
          <h1 className="mt-5 font-display text-2xl text-ink-950">Review unavailable</h1>
          <p className="mt-3 text-sm text-ink-700 leading-relaxed">
            This agreement review link is expired, has been revoked, or the agreement has already been decided. Please contact the freelancer if you need a new review link.
          </p>
          <div className="mt-6">
            <Link href="/">
              <Button variant="secondary" className="w-full">Return to Payroost</Button>
            </Link>
          </div>
        </Card>
      </div>
    );
  }

  const reviewRow = (data as unknown[])[0] as Parameters<typeof PublicReviewView>[0]["reviewData"];

  return (
    <div className="min-h-screen bg-slate-50">
      <PublicBrandHeader maxWidthClass="max-w-4xl" subtitle="Agreement Review" />
      <PublicReviewView token={token} reviewData={reviewRow} />
    </div>
  );
}

// Helper for Next.js 15+ promise params
async function contextParams<T>(params: Promise<T> | T): Promise<T> {
  return await params;
}
