"use server";

import { redirect } from "next/navigation";
import type { AuthError } from "@supabase/supabase-js";
import { getAuthedClient } from "@/lib/auth";
import { fieldErrors, passwordRecoverySchema, resetPasswordSchema, profileSchema, signInSchema, signUpSchema, type FieldErrors } from "@/lib/schemas";
import { createClient } from "@/lib/supabase/server";
import { safeRedirectPath } from "@/lib/utils";

export interface AuthFormState {
  errors?: FieldErrors;
  /** Form-level failure, shown as an alert. */
  message?: string;
  /** Non-error outcome, e.g. "check your email". */
  notice?: string;
  /** Echoed back so a failed submit does not wipe what the user typed. Never the password. */
  values?: { email?: string; displayName?: string };
}

function text(formData: FormData, name: string) {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

/** Turns an Auth failure into something a person can act on, without leaking internals. */
function authMessage(error: AuthError, action: "sign-in" | "sign-up") {
  switch (error.code) {
    case "invalid_credentials":
      return "Incorrect email or password.";
    case "email_not_confirmed":
      return "Confirm your email first: open the link we sent you, then sign in.";
    case "user_already_exists":
      return "An account with that email already exists. Try signing in.";
    case "weak_password":
      return "That password is too easy to guess. Try a longer or less common one.";
    case "signup_disabled":
      return "New accounts aren't being accepted right now.";
    case "over_request_rate_limit":
    case "over_email_send_rate_limit":
      return "Too many attempts. Wait a few minutes and try again.";
    default:
      console.error(`Supabase ${action} failed`, error.code ?? error.status, error.message);
      return "Something went wrong on our side. Please try again.";
  }
}

export async function signIn(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const values = { email: text(formData, "email") };
  const parsed = signInSchema.safeParse({ email: values.email, password: text(formData, "password") });
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) return { message: authMessage(error, "sign-in"), values };

  redirect(safeRedirectPath(text(formData, "next")));
}

export async function signUp(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const values = { email: text(formData, "email"), displayName: text(formData, "displayName") };
  const parsed = signUpSchema.safeParse({ ...values, password: text(formData, "password") });
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const next = safeRedirectPath(text(formData, "next"));
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: parsed.data.displayName ? { display_name: parsed.data.displayName } : undefined,
      emailRedirectTo: new URL(`/auth/callback?next=${encodeURIComponent(next)}`, siteUrl).toString(),
    },
  });
  if (error) return { message: authMessage(error, "sign-up"), values };

  // A session means email confirmation is off: the user is already signed in.
  if (data.session) redirect(next);

  // Identical outcome whether or not the address is already registered, so this
  // form cannot be used to discover who has an account.
  return { notice: `Check ${parsed.data.email} for a confirmation link. Open it to finish creating your account.`, values: { email: parsed.data.email } };
}

export async function signOut() {
  const supabase = await createClient();
  // "local" ends this device's session only; other devices stay signed in.
  const { error } = await supabase.auth.signOut({ scope: "local" });
  if (error) console.error("Supabase sign-out failed", error.code ?? error.status, error.message);
  redirect("/");
}

export async function requestPasswordReset(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = passwordRecoverySchema.safeParse({ email: text(formData, "email") });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  // Fail closed until the operator verifies Supabase's exact recovery redirect.
  if (process.env.VELORA_PASSWORD_RECOVERY_ENABLED !== "true") return { message: "Password recovery is not configured yet. Please try again later." };
  const site = new URL(process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000");
  if (site.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && site.protocol === "http:" && ["localhost", "127.0.0.1"].includes(site.hostname))) return { message: "Password recovery is not configured yet. Please try again later." };
  const next = safeRedirectPath(text(formData, "next"));
  const callback = new URL("/auth/callback", site);
  callback.searchParams.set("next", `/reset-password?next=${encodeURIComponent(next)}`);
  const supabase = await createClient();
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, { redirectTo: callback.toString() });
  if (error) console.warn("Password recovery request failed", error.code ?? error.status);
  // Identical response for registered/unregistered accounts and provider errors.
  return { notice: "If an account exists for that email, a password-reset link will be sent. Check your inbox and spam folder, and open the link in this browser." };
}

export async function resetPassword(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = resetPasswordSchema.safeParse({ password: text(formData, "password"), confirmPassword: text(formData, "confirmPassword") });
  if (!parsed.success) return { errors: fieldErrors(parsed.error) };
  const supabase = await createClient();
  const { data, error: userError } = await supabase.auth.getUser();
  if (userError || !data.user || data.user.is_anonymous) return { message: "Your reset link has expired. Request a new link and open it in the same browser." };
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    console.warn("Password update failed", error.code ?? error.status);
    return { message: error.code === "weak_password" ? "Choose a stronger password." : "Couldn't update your password. Request a new link and try again." };
  }
  const { error: signOutError } = await supabase.auth.signOut({ scope: "local" });
  if (signOutError) console.warn("Password reset sign-out failed", signOutError.code ?? signOutError.status);
  redirect(`/sign-in?passwordReset=1&next=${encodeURIComponent(safeRedirectPath(text(formData, "next")))}`);
}

export async function updateProfile(_state: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const values = { displayName: text(formData, "displayName") };
  const parsed = profileSchema.safeParse(values);
  if (!parsed.success) return { errors: fieldErrors(parsed.error), values };

  const session = await getAuthedClient();
  if (!session) redirect("/sign-in?next=/account");

  // Row Level Security limits this to the caller's own row; the column-level
  // grant limits it to display_name. The id filter just makes the intent explicit.
  const { data, error } = await session.supabase
    .from("profiles")
    .update({ display_name: parsed.data.displayName || null })
    .eq("id", session.user.id)
    .select("id");
  if (error || data.length === 0) {
    console.error("Profile update failed", error?.code, error?.message ?? "no matching profile row");
    return { message: "Couldn't save your changes. Please try again.", values };
  }
  return { notice: "Saved.", values };
}
