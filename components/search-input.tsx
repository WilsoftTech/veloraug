"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search, X } from "lucide-react";
import { MAX_SEARCH_LENGTH, searchScopeParam } from "@/lib/utils";
import type { SearchScope } from "@/types/media";

const DEBOUNCE_MS = 300;
const MIN_QUERY_LENGTH = 2;

interface SearchInputProps {
  /** The `q` currently in the URL. */
  query: string;
  scope: SearchScope;
}

/**
 * Debounced live search. The query lives in the URL and the results are
 * rendered by the server page, so searches are shareable and stale responses
 * are dropped by the router (the latest navigation wins).
 */
export function SearchInput({ query, scope }: SearchInputProps) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const lastNavigated = useRef(query);
  const [isPending, startTransition] = useTransition();

  function navigate(raw: string) {
    window.clearTimeout(timerRef.current);
    const next = raw.trim();
    if (next.length > 0 && next.length < MIN_QUERY_LENGTH) return;
    if (next === lastNavigated.current) return;

    lastNavigated.current = next;
    const params = new URLSearchParams();
    if (next) {
      params.set("q", next);
      const type = searchScopeParam(scope);
      if (type) params.set("type", type);
    }
    const search = params.toString();
    startTransition(() => router.replace(search ? `/search?${search}` : "/search", { scroll: false }));
  }

  // Follow URL changes we did not cause (trending-search links, back/forward).
  useEffect(() => {
    const input = inputRef.current;
    if (input && query !== lastNavigated.current) {
      input.value = query;
      lastNavigated.current = query;
    }
  }, [query]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  function clear() {
    const input = inputRef.current;
    if (!input) return;
    input.value = "";
    navigate("");
    input.focus();
  }

  return (
    <form
      action="/search"
      role="search"
      onSubmit={(event) => {
        event.preventDefault();
        navigate(inputRef.current?.value ?? "");
      }}
      className="relative"
    >
      <label htmlFor="search-input" className="sr-only">
        Search movies and shows
      </label>
      <span aria-hidden className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted">
        {isPending ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" /> : <Search className="size-5" />}
      </span>
      <input
        ref={inputRef}
        id="search-input"
        name="q"
        type="search"
        defaultValue={query}
        maxLength={MAX_SEARCH_LENGTH}
        autoFocus={!query}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        enterKeyHint="search"
        placeholder="Search movies & shows…"
        onChange={(event) => {
          window.clearTimeout(timerRef.current);
          const value = event.target.value;
          timerRef.current = window.setTimeout(() => navigate(value), DEBOUNCE_MS);
        }}
        className="peer h-12 w-full rounded-default border border-border bg-canvas-subtle/80 pl-12 pr-12 text-base text-foreground placeholder:text-muted/80 transition-[border-color,box-shadow] focus:border-highlight focus:shadow-focus focus-visible:outline-none [&::-webkit-search-cancel-button]:appearance-none"
      />
      <button
        type="button"
        aria-label="Clear search"
        onClick={clear}
        className="absolute right-0.5 top-1/2 grid size-11 -translate-y-1/2 place-items-center rounded-default text-muted transition-colors hover:text-foreground peer-placeholder-shown:hidden"
      >
        <X aria-hidden className="size-5" />
      </button>
    </form>
  );
}
