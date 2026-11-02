import type { Metadata } from "next";
import Link from "next/link";
import { Mic } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { listVjs } from "@/lib/catalogue";

export const metadata: Metadata = {
  title: "VJs",
  description: "The VJs translating movies and series on Velora UG.",
  alternates: { canonical: "/vjs" },
};

// Catalogue reads go through fetch; without this a prerender would freeze the catalogue at build time.
export const revalidate = 300;

/** Active VJs in editorial order (inactive VJs are hidden by the read policy). */
export default async function VjsPage() {
  const vjs = await listVjs();

  return (
    <div className="page-container py-6 sm:py-8">
      <h1 className="flex items-center gap-3 text-headline-md">
        <span aria-hidden className="grid size-11 place-items-center rounded-default border border-border bg-surface text-highlight"><Mic className="size-5" /></span>
        VJs
      </h1>
      {vjs.length === 0 ? (
        <EmptyState icon={<Mic className="size-6" />} title="No VJs yet" description="VJs appear here once their titles are published." />
      ) : (
        <ul className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
          {vjs.map((vj) => (
            <li key={vj.id}>
              <Link href={`/vjs/${vj.slug}`} className="flex h-full min-h-24 flex-col items-center justify-center rounded-lg border border-border bg-surface px-3 py-4 text-center transition-colors hover:border-highlight/60 hover:bg-surface-elevated hover:text-highlight">
                <span className="text-label-lg uppercase">{vj.name}</span>
                {vj.description && <span className="mt-1 line-clamp-2 text-body-sm text-muted">{vj.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
