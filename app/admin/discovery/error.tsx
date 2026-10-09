"use client";
import { EmptyState } from "@/components/empty-state";
import { buttonClass } from "@/components/button";
export default function Error({ reset }: { reset: () => void }) { return <EmptyState as="h1" title="Could not load offline review" description="Check the synthetic fixture configuration and local inbox."><button className={buttonClass("secondary")} onClick={reset}>Try again</button></EmptyState>; }
