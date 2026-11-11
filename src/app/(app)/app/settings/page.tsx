import { Suspense } from "react";
import { Card } from "@/components/ui/card";
import { PayPalSellerSettingsCard } from "@/features/freelancer/paypal-seller-settings-card";

export default function SettingsPage() {
  return (
    <>
      <p className="text-sm font-bold uppercase tracking-[0.14em] text-teal-700">Settings</p>
      <h1 className="mt-2 font-display text-4xl text-ink-950">Account & Payouts</h1>

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

      <Card className="mt-8 max-w-2xl p-6">
        <h2 className="font-display text-xl text-ink-950">Profile controls</h2>
        <p className="mt-3 leading-7 text-ink-700">
          Your Supabase account is the authentication boundary. Profile editing is synchronized with your active session.
        </p>
      </Card>
    </>
  );
}
