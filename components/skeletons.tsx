import { cn } from "@/lib/utils";

function Bone({ className }: { className?: string }) {
  return <div aria-hidden className={cn("animate-pulse rounded-default bg-surface-elevated motion-reduce:animate-none", className)} />;
}

/** Matches MovieCard geometry so real content lands without layout shift. */
function PosterSkeleton({ className }: { className?: string }) {
  return (
    <div className={className}>
      <Bone className="aspect-[2/3] rounded-lg" />
      <Bone className="mt-2 h-3.5 w-4/5" />
      <Bone className="mt-1.5 h-3 w-1/2" />
    </div>
  );
}

export function SectionSkeleton() {
  return (
    <div role="status" aria-label="Loading">
      <Bone className="mb-4 h-6 w-40" />
      <div className="page-bleed no-scrollbar flex gap-3 overflow-hidden md:gap-4">
        {Array.from({ length: 8 }, (_, index) => (
          <PosterSkeleton key={index} className="w-36 shrink-0 sm:w-44 lg:w-48" />
        ))}
      </div>
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div
      role="status"
      aria-label="Loading"
      className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 md:gap-x-6 lg:grid-cols-5 xl:grid-cols-6"
    >
      {Array.from({ length: 12 }, (_, index) => (
        <PosterSkeleton key={index} />
      ))}
    </div>
  );
}

export function ListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-4 border-b border-border py-3 last:border-b-0">
          <Bone className="aspect-[2/3] w-14 shrink-0" />
          <div className="flex-1">
            <Bone className="h-4 w-2/3" />
            <Bone className="mt-2 h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Generic route fallback: a heading plus a poster grid. */
export function PageSkeleton() {
  return (
    <div className="page-container py-6 sm:py-8">
      <Bone className="mb-6 h-8 w-40" />
      <GridSkeleton />
    </div>
  );
}

export function HeroSkeleton() {
  return <Bone className="h-[32rem] w-full rounded-none sm:h-[36rem] lg:h-[40rem]" />;
}
