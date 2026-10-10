"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { requestPasswordReset, resetPassword, signIn, signUp, type AuthFormState } from "@/app/auth/actions";
import { buttonClass } from "@/components/button";
import { Field } from "@/components/form-field";

interface AuthFormProps {
  mode: "sign-in" | "sign-up" | "forgot-password" | "reset-password";
  /** Same-origin path to return to afterwards (already validated by the page). */
  next: string;
  /** Set when the email-confirmation link could not be used. */
  callbackFailed?: boolean;
  passwordReset?: boolean;
}

const COPY = {
  "forgot-password": {
    title: "Reset your password", lead: "Enter your account email to request a reset link.", submit: "Send reset link", pending: "Requesting link…",
    switchText: "Remember your password?", switchLink: "Sign in", switchHref: "/sign-in",
  },
  "reset-password": {
    title: "Choose a new password", lead: "Use at least 8 characters and a password you don't use elsewhere.", submit: "Update password", pending: "Updating password…",
    switchText: "Link expired?", switchLink: "Request a new link", switchHref: "/forgot-password",
  },
  "sign-in": {
    title: "Sign in",
    lead: "Welcome back. Your list is waiting.",
    submit: "Sign in",
    pending: "Signing in…",
    switchText: "New to Velora UG?",
    switchLink: "Create an account",
    switchHref: "/sign-up",
  },
  "sign-up": {
    title: "Create your account",
    lead: "Save titles to My List and pick up where you left off on any device.",
    submit: "Create account",
    pending: "Creating account…",
    switchText: "Already have an account?",
    switchLink: "Sign in",
    switchHref: "/sign-in",
  },
} as const;

const initialState: AuthFormState = {};

/** One form for both sign-in and sign-up; the server actions own validation and the Auth call. */
export function AuthForm({ mode, next, callbackFailed = false, passwordReset = false }: AuthFormProps) {
  const copy = COPY[mode];
  const action = { "sign-in": signIn, "sign-up": signUp, "forgot-password": requestPasswordReset, "reset-password": resetPassword }[mode];
  const [state, formAction, pending] = useActionState(action, initialState);
  const switchHref = next === "/" ? copy.switchHref : `${copy.switchHref}?next=${encodeURIComponent(next)}`;

  return (
    <div className="page-container max-w-md py-8 sm:py-12">
      <h1 className="text-headline-md md:text-headline-lg">{copy.title}</h1>
      <p className="mt-2 text-body-md text-muted">{copy.lead}</p>
      {passwordReset && <p role="status" className="mt-4 text-body-md text-highlight">Password updated. Sign in with your new password.</p>}

      <form
        action={formAction}
        className="mt-6 space-y-5 rounded-lg border border-border bg-surface p-5 backdrop-blur-md sm:p-6"
      >
        <input type="hidden" name="next" value={next} />

        {callbackFailed && !state.message && (
          <p role="alert" className="rounded-default border border-destructive/40 px-4 py-3 text-body-md text-destructive">
            {mode === "forgot-password" ? "That reset link couldn't be used. Request a new link and open it in the same browser." : "That confirmation link couldn't be used. If you already confirmed your email, just sign in below."}
          </p>
        )}
        {state.message && (
          <p role="alert" className="rounded-default border border-destructive/40 px-4 py-3 text-body-md text-destructive">
            {state.message}
          </p>
        )}
        {state.notice && (
          <p role="status" className="rounded-default border border-highlight/30 bg-accent/12 px-4 py-3 text-body-md">
            {state.notice}
          </p>
        )}

        {mode === "sign-up" && (
          <Field id="displayName" label="Display name (optional)" errors={state.errors?.displayName}>
            {(props) => (
              <input {...props} name="displayName" type="text" autoComplete="nickname" maxLength={50} defaultValue={state.values?.displayName} />
            )}
          </Field>
        )}

        {mode !== "reset-password" && <Field id="email" label="Email" errors={state.errors?.email}>
          {(props) => (
            <input {...props} name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} defaultValue={state.values?.email} />
          )}
        </Field>}

        {mode !== "forgot-password" && <Field
          id="password"
          label="Password"
          errors={state.errors?.password}
          hint={mode !== "sign-in" ? "At least 8 characters." : undefined}
        >
          {(props) => (
            <input
              {...props}
              name="password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={mode !== "sign-in" ? 8 : undefined}
              maxLength={72}
            />
          )}
        </Field>}
        {mode === "reset-password" && <Field id="confirmPassword" label="Confirm new password" errors={state.errors?.confirmPassword}>
          {(props) => <input {...props} name="confirmPassword" type="password" autoComplete="new-password" required minLength={8} maxLength={72} />}
        </Field>}

        <button type="submit" disabled={pending} aria-disabled={pending} className={buttonClass("primary", "w-full")}>
          {pending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {pending ? copy.pending : copy.submit}
        </button>
      </form>
      {mode === "sign-in" && <Link href={`/forgot-password?next=${encodeURIComponent(next)}`} className="mt-4 inline-flex min-h-11 items-center text-highlight underline-offset-4 hover:underline">Forgot password?</Link>}

      <p className="mt-5 text-center text-body-md text-muted">
        {copy.switchText}{" "}
        <Link href={switchHref} className="inline-flex min-h-11 items-center font-semibold text-highlight underline-offset-4 hover:underline">
          {copy.switchLink}
        </Link>
      </p>
    </div>
  );
}
