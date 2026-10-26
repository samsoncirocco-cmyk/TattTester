"use client";

import { Suspense, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import StudioShell from "@/components/studio/StudioShell";
import QuietHeadline from "@/components/quiet/QuietHeadline";
import FormField from "@/components/punk/FormField";
import AuthBrandPanel from "@/components/punk/AuthBrandPanel";
import { useUser } from "@/lib/tattStorage";
import { mapFirebaseAuthError } from "@/lib/authErrors";

/** Only same-site relative paths are allowed as post-auth destinations. */
function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
  return "/designs";
}

function LoginPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const destination = safeRedirect(searchParams?.get("redirect") ?? null);
  const { signIn, error: authError } = useUser();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);

  const handleGoogle = async () => {
    setOauthError(null);
    const { signInWithGoogle } = await import("@/services/authService");
    try {
      await signInWithGoogle();
      router.push(destination);
    } catch (err) {
      setOauthError(mapFirebaseAuthError(err));
    }
  };

  return (
    <StudioShell quiet footer={false}>
      <div className="grid grid-cols-1 lg:grid-cols-2 min-h-[calc(100vh-140px)]">
        <AuthBrandPanel
          quiet
          quote="Describe the idea in your own words. Two cuts come back. The tattoo is still your artist's."
          attribution="Directions, not a finished tattoo"
        />

        <div className="px-6 md:px-12 py-14 md:py-20 flex flex-col justify-center">
          <div className="max-w-md w-full mx-auto">
            <div className="flex items-center justify-between text-[12px] text-quiet-dim font-body mb-10">
              <span>Log in</span>
              <Link href={destination !== "/designs" ? `/signup?redirect=${encodeURIComponent(destination)}` : "/signup"} className="hover:text-white">
                New here?&nbsp;Sign up
              </Link>
            </div>

            <QuietHeadline>Welcome back</QuietHeadline>
            <p className="mt-5 text-[14px] text-quiet-dim font-body leading-[1.7]">
              Pick up where you left off.
            </p>

            <form
              onSubmit={async (e) => {
                e.preventDefault();
                if (!email.trim() || !password || submitting) return;
                setSubmitting(true);
                const user = await signIn(email, password);
                setSubmitting(false);
                if (user) router.push(destination);
              }}
              className="mt-10 space-y-6"
            >
              <FormField
                quiet
                id="email"
                label="Email"
                type="email"
                value={email}
                onChange={setEmail}
                placeholder="you@somewhere.com"
                autoComplete="email"
              />
              <FormField
                quiet
                id="password"
                label="Password"
                type="password"
                value={password}
                onChange={setPassword}
                placeholder="••••••••"
                autoComplete="current-password"
              />

              {(authError || oauthError) && (
                <div className="border border-pink/60 p-5 text-[13px] text-pink font-body leading-[1.6]">
                  {authError || oauthError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting}
                className="press inline-flex items-center justify-center w-full px-8 py-4 font-body text-[15px] leading-none bg-quiet text-black hover:bg-white disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? "Signing in…" : "Log in"}
              </button>
            </form>

            <div className="mt-12 flex items-center gap-4">
              <div className="flex-1 border-t hairline-quiet-soft" />
              <span className="text-[12px] text-quiet-dim font-body">
                Or continue with
              </span>
              <div className="flex-1 border-t hairline-quiet-soft" />
            </div>

            <div className="mt-10 grid grid-cols-3 gap-3">
              <button
                onClick={handleGoogle}
                className="text-[12px] text-quiet hover:text-black hover:bg-quiet border hairline-quiet px-3 py-3 press font-body"
              >
                Google
              </button>
              {["Apple", "Github"].map((p) => (
                <button
                  key={p}
                  disabled
                  title="Coming soon"
                  className="text-[12px] text-white/30 border hairline-quiet-soft px-3 py-3 font-body cursor-not-allowed"
                >
                  {p}&nbsp;·&nbsp;Soon
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </StudioShell>
  );
}

export default function LoginPage() {
  // useSearchParams requires a Suspense boundary in the app router.
  return (
    <Suspense fallback={<LoginPageInner />}>
      <LoginPageInner />
    </Suspense>
  );
}
