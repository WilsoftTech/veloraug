"use client";

import { Children, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Scroll-snap carousel: swiping is native browser scrolling. The slides stay
 * server-rendered; this island only adds the dots and arrows.
 */
export function HeroCarousel({ children, label }: { children: ReactNode; label: string }) {
  const slides = Children.toArray(children);
  const trackRef = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  function onScroll() {
    const track = trackRef.current;
    if (track) setIndex(Math.round(track.scrollLeft / track.clientWidth));
  }

  function goTo(target: number) {
    const track = trackRef.current;
    if (!track) return;
    const next = (target + slides.length) % slides.length;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    track.scrollTo({ left: next * track.clientWidth, behavior: reduceMotion ? "auto" : "smooth" });
  }

  return (
    <section aria-roledescription="carousel" aria-label={label} className="relative">
      <div
        ref={trackRef}
        onScroll={onScroll}
        className="no-scrollbar relative flex snap-x snap-mandatory overflow-x-auto overscroll-x-contain"
      >
        {slides.map((slide, slideIndex) => (
          <div
            key={slideIndex}
            role="group"
            aria-roledescription="slide"
            aria-label={`${slideIndex + 1} of ${slides.length}`}
            inert={slideIndex !== index}
            className="w-full shrink-0 snap-center"
          >
            {slide}
          </div>
        ))}
      </div>

      {slides.length > 1 && (
        <div className="page-container pointer-events-none absolute inset-x-0 bottom-2 flex items-center justify-center gap-3 md:bottom-5">
          <button
            type="button"
            aria-label="Previous slide"
            onClick={() => goTo(index - 1)}
            className="pointer-events-auto hidden size-10 place-items-center rounded-default border border-border bg-surface backdrop-blur-md transition-colors hover:border-highlight/40 hover:bg-surface-elevated md:grid"
          >
            <ChevronLeft aria-hidden className="size-5" />
          </button>
          <div className="pointer-events-auto flex">
            {slides.map((_, dotIndex) => (
              <button
                key={dotIndex}
                type="button"
                aria-label={`Show slide ${dotIndex + 1}`}
                aria-current={dotIndex === index}
                onClick={() => goTo(dotIndex)}
                className="grid h-11 w-8 place-items-center"
              >
                <span
                  className={cn(
                    "h-1.5 rounded-full transition-all duration-200",
                    dotIndex === index ? "w-5 bg-highlight" : "w-1.5 bg-foreground/30",
                  )}
                />
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Next slide"
            onClick={() => goTo(index + 1)}
            className="pointer-events-auto hidden size-10 place-items-center rounded-default border border-border bg-surface backdrop-blur-md transition-colors hover:border-highlight/40 hover:bg-surface-elevated md:grid"
          >
            <ChevronRight aria-hidden className="size-5" />
          </button>
        </div>
      )}
    </section>
  );
}
