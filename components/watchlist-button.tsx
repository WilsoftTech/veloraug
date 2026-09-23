"use client";

import { Check, Plus } from "lucide-react";
import { buttonClass, type ButtonVariant } from "@/components/button";
import { sameTitle, useWatchlist, type MutationError } from "@/lib/watchlist";
import type { WatchlistItem } from "@/types/watchlist";

/** What a person sees when a change to My List had to be undone. */
export const MUTATION_MESSAGES: Record<MutationError, string> = {
  "signed-out": "Your session has expired. Sign in again to update My List.",
  invalid: "That title can't be saved.",
  full: "My List is full (500 titles). Remove one to add another.",
  unavailable: "Couldn't update My List. Try again.",
  loading: "Still loading your list. Try again in a moment.",
};

interface WatchlistButtonProps {
  item: WatchlistItem;
  variant?: ButtonVariant;
  className?: string;
}

export function WatchlistButton({ item, variant = "secondary", className }: WatchlistButtonProps) {
  const { has, toggle, mutationError } = useWatchlist();
  const saved = has(item);
  const Icon = saved ? Check : Plus;
  const failure = mutationError && sameTitle(mutationError.item, item) ? mutationError.error : null;

  return (
    <>
      <button type="button" aria-pressed={saved} onClick={() => toggle(item)} className={buttonClass(variant, className)}>
        <Icon aria-hidden className="size-4" />
        {saved ? "In My List" : "Add to My List"}
      </button>
      {failure && (
        <p role="alert" className="w-full text-body-sm text-destructive">
          {MUTATION_MESSAGES[failure]}
        </p>
      )}
    </>
  );
}
