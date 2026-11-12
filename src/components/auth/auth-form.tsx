"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";

const credentials = z.object({ email: z.email("Enter a valid email address."), password: z.string().min(8, "Use at least 8 characters.") });

export function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const isSignUp = mode === "signup";

  async function onSubmit(formData: FormData) {
    const parsed = credentials.safeParse({ email: formData.get("email"), password: formData.get("password") });
    if (!parsed.success) return setMessage(parsed.error.issues[0]?.message ?? "Check your details.");
    setIsPending(true); setMessage(null);
    try {
      const supabase = createClient();
      const result = isSignUp
        ? await supabase.auth.signUp({ email: parsed.data.email, password: parsed.data.password, options: { emailRedirectTo: `${window.location.origin}/app` } })
        : await supabase.auth.signInWithPassword(parsed.data);
      if (result.error) setMessage(result.error.message);
      else if (isSignUp) setMessage("Check your email to confirm your account, then sign in.");
      else router.push("/app");
    } catch {
      setMessage("Supabase is not configured yet. Add the public environment variables to continue.");
    } finally { setIsPending(false); }
  }

  return <form action={onSubmit} className="space-y-5" noValidate>
    <label className="block text-sm font-semibold text-ink-800">Email<input autoComplete="email" className="mt-2 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-base outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 sm:text-sm" name="email" type="email" required /></label>
    <label className="block text-sm font-semibold text-ink-800">Password<input autoComplete={isSignUp ? "new-password" : "current-password"} className="mt-2 block w-full rounded-xl border border-ink-200 bg-white px-3 py-2.5 text-base outline-none transition focus:border-teal-600 focus:ring-2 focus:ring-teal-600/15 sm:text-sm" name="password" type="password" required minLength={8} /></label>
    {message && <p aria-live="polite" className="rounded-lg bg-ink-50 p-3 text-sm text-ink-700">{message}</p>}
    <Button className="w-full" disabled={isPending} type="submit">{isPending ? "Please wait…" : isSignUp ? "Create account" : "Sign in"}</Button>
    <p className="text-center text-sm text-ink-700">{isSignUp ? "Already have an account?" : "New to Payroost?"} <Link className="font-bold text-teal-700 underline underline-offset-4" href={isSignUp ? "/login" : "/signup"}>{isSignUp ? "Sign in" : "Create one"}</Link></p>
  </form>;
}
