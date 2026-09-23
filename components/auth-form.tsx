"use client";

import { useActionState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { signIn, signUp, type AuthFormState } from "@/app/auth/actions";
import { buttonClass } from "@/components/button";
import { Field } from "@/components/form-field";

interface AuthFormProps {
  mode: "sign-in" | "sign-up";
  /** Same-origin path to return to afterwards (already validated by the page). */
  next: string;
  /** Set when the email-confirmation link could not be used. */
  callbackFailed?: boolean;
}

const COPY = {
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
export function AuthForm({ mode, next, callbackFailed = false }: AuthFormProps) {
  const copy = COPY[mode];
  const [state, formAction, pending] = useActionState(mode === "sign-in" ? signIn : signUp, initialState);
  const switchHref = next === "/" ? copy.switchHref : `${copy.switchHref}?next=${encodeURIComponent(next)}`;

  return (
    <div className="page-container max-w-md py-8 sm:py-12">
      <h1 className="text-headline-md md:text-headline-lg">{copy.title}</h1>
      <p className="mt-2 text-body-md text-muted">{copy.lead}</p>

      <form
        action={formAction}
        className="mt-6 space-y-5 rounded-lg border border-border bg-surface p-5 backdrop-blur-md sm:p-6"
      >
        <input type="hidden" name="next" value={next} />

        {callbackFailed && !state.message && (
          <p role="alert" className="rounded-default border border-destructive/40 px-4 py-3 text-body-md text-destructive">
            That confirmation link couldn&apos;t be used. If you already confirmed your email, just sign in below.
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

        <Field id="email" label="Email" errors={state.errors?.email}>
          {(props) => (
            <input {...props} name="email" type="email" autoComplete="email" inputMode="email" required maxLength={254} defaultValue={state.values?.email} />
          )}
        </Field>

        <Field
          id="password"
          label="Password"
          errors={state.errors?.password}
          hint={mode === "sign-up" ? "At least 8 characters." : undefined}
        >
          {(props) => (
            <input
              {...props}
              name="password"
              type="password"
              autoComplete={mode === "sign-in" ? "current-password" : "new-password"}
              required
              minLength={mode === "sign-up" ? 8 : undefined}
              maxLength={72}
            />
          )}
        </Field>

        <button type="submit" disabled={pending} aria-disabled={pending} className={buttonClass("primary", "w-full")}>
          {pending && <Loader2 aria-hidden className="size-4 animate-spin motion-reduce:animate-none" />}
          {pending ? copy.pending : copy.submit}
        </button>
      </form>

      <p className="mt-5 text-center text-body-md text-muted">
        {copy.switchText}{" "}
        <Link href={switchHref} className="inline-flex min-h-11 items-center font-semibold text-highlight underline-offset-4 hover:underline">
          {copy.switchLink}
        </Link>
      </p>
    </div>
  );
}
