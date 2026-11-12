import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { PayPalSellerSettingsCard } from "@/features/freelancer/paypal-seller-settings-card";
import { ProfileSettingsCard } from "@/features/freelancer/profile-settings-card";
import { getMyProfile } from "@/features/projects/data";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const profile = await getMyProfile();

  return (
    <>
      <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Settings</p>
      <h1 className="mt-2 font-display text-3xl text-ink-950 sm:text-4xl">Account & Payouts</h1>

      {/* Phase 3B.R1: PayPal Seller Payout Connection */}
      <Suspense
        fallback={
          <Card className="mt-8 max-w-2xl p-6">
            <p className="text-sm text-ink-500">Loading payout settings...</p>
          </Card>
        }
      >
        <PayPalSellerSettingsCard />
      </Suspense>

      <ProfileSettingsCard
        email={profile.email}
        initialCountryCode={profile.countryCode}
        initialDisplayName={profile.displayName}
        isConfigured={profile.isConfigured}
      />
    </>
  );
}
