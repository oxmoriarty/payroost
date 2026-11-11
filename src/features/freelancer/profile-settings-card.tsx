"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Loader2, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

type ProfileSettingsCardProps = {
  isConfigured: boolean;
  email: string | null;
  initialDisplayName: string;
  initialCountryCode: string;
};

export function ProfileSettingsCard({
  isConfigured,
  email,
  initialDisplayName,
  initialCountryCode,
}: ProfileSettingsCardProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(initialDisplayName);
  const [countryCode, setCountryCode] = useState(initialCountryCode);
  const [saving, setSaving] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{
    type: "success" | "error";
    text: string;
  } | null>(null);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setStatusMessage(null);

    if (!displayName.trim()) {
      setStatusMessage({ type: "error", text: "Display name cannot be empty." });
      return;
    }

    const trimmedCountry = countryCode.trim().toUpperCase();
    if (trimmedCountry && !/^[A-Z]{2}$/.test(trimmedCountry)) {
      setStatusMessage({
        type: "error",
        text: "Country code must be a 2-letter ISO code such as US or GB.",
      });
      return;
    }

    setSaving(true);
    try {
      const csrfRes = await fetch("/api/app/csrf", { headers: { "Cache-Control": "no-store" } });
      if (!csrfRes.ok) {
        setStatusMessage({
          type: "error",
          text: "Unable to establish a security token. Please reload and sign in again.",
        });
        return;
      }
      const { csrfToken } = (await csrfRes.json()) as { csrfToken?: string };
      if (!csrfToken) {
        setStatusMessage({ type: "error", text: "Missing security token." });
        return;
      }

      const res = await fetch("/api/app/profile", {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "x-csrf-token": csrfToken,
          "Cache-Control": "no-store",
        },
        body: JSON.stringify({
          displayName: displayName.trim(),
          countryCode: trimmedCountry,
        }),
      });

      const payload = (await res.json()) as {
        error?: string;
        message?: string;
        data?: { displayName: string; countryCode: string | null };
      };

      if (!res.ok) {
        setStatusMessage({
          type: "error",
          text: payload.message || payload.error || "Could not update your profile.",
        });
        return;
      }

      setDisplayName(payload.data?.displayName ?? displayName.trim());
      setCountryCode(payload.data?.countryCode ?? "");
      setStatusMessage({ type: "success", text: "Profile updated." });
      router.refresh();
    } catch {
      setStatusMessage({ type: "error", text: "Network error while saving profile." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="mt-8 max-w-2xl p-6">
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-teal-50 text-teal-700">
          <UserCog size={20} />
        </span>
        <div>
          <h2 className="font-display text-xl text-ink-950">Profile details</h2>
          <p className="mt-1 text-sm text-ink-700">
            Update how your name appears in the workspace header, projects, and activity audit logs.
          </p>
        </div>
      </div>

      {!isConfigured ? (
        <p className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          Profile editing requires Supabase authentication to be configured.
        </p>
      ) : (
        <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
          {email && (
            <div>
              <span className="block text-xs font-bold uppercase tracking-wider text-ink-600">
                Account email
              </span>
              <p className="mt-1 text-sm font-medium text-ink-900">{email}</p>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-semibold text-ink-800">
              Display name
              <input
                className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm font-normal text-ink-950 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                maxLength={80}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Your full name or studio"
                required
                value={displayName}
              />
            </label>

            <label className="block text-sm font-semibold text-ink-800">
              Country code (optional)
              <input
                className="mt-1.5 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-sm font-normal uppercase text-ink-950 outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15"
                maxLength={2}
                onChange={(e) => setCountryCode(e.target.value.toUpperCase())}
                placeholder="US"
                value={countryCode}
              />
            </label>
          </div>

          {statusMessage && (
            <div
              className={`flex items-center gap-2 rounded-xl border p-3 text-sm ${
                statusMessage.type === "success"
                  ? "border-emerald-200 bg-emerald-50 text-emerald-900"
                  : "border-red-200 bg-red-50 text-red-900"
              }`}
              role="status"
            >
              {statusMessage.type === "success" && <CheckCircle2 className="h-4 w-4 shrink-0" />}
              <span>{statusMessage.text}</span>
            </div>
          )}

          <div className="flex justify-end">
            <Button disabled={saving} type="submit">
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save profile"
              )}
            </Button>
          </div>
        </form>
      )}
    </Card>
  );
}
