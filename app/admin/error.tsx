"use client";
import { EmptyState } from "@/components/empty-state";
import { buttonClass } from "@/components/button";

export default function Error({ retry }: { retry: () => void }) {
  return (
    <EmptyState as="h1" title="Could not load the admin" description="The review data is unavailable right now. Try again in a moment.">
      <button type="button" className={buttonClass("secondary")} onClick={() => retry()}>
        Try again
      </button>
    </EmptyState>
  );
}
