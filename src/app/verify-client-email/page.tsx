import { PublicBrandHeader } from "@/components/brand";
import { VerifyEmailClient } from "./verify-email-client";

export default async function VerifyClientEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return (
    <div className="flex min-h-screen flex-col bg-slate-50">
      <PublicBrandHeader maxWidthClass="max-w-2xl" subtitle="Email Verification" />
      <VerifyEmailClient token={token} />
    </div>
  );
}
