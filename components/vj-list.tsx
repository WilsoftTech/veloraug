import Link from "next/link";
import type { VjSummary } from "@/types/catalogue";

/** "Available from" line: every VJ a title or episode can be watched from, each linking to the VJ's page. */
export function VjList({ vjs, label = "Available from" }: { vjs: VjSummary[]; label?: string }) {
  if (vjs.length === 0) return null;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-body-md text-foreground/80">
      <span className="text-muted">{label}</span>
      {vjs.map((vj, index) => (
        <span key={vj.id} className="inline-flex items-center gap-2">
          {index > 0 && <span aria-hidden>·</span>}
          <Link href={`/vjs/${vj.slug}`} className="font-semibold text-highlight transition-colors hover:text-foreground">
            {vj.name}
          </Link>
        </span>
      ))}
    </p>
  );
}
