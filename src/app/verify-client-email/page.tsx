import { VerifyEmailClient } from "./verify-email-client";

export default async function VerifyClientEmailPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string }>;
}) {
  const { token } = await searchParams;

  return <VerifyEmailClient token={token} />;
}
