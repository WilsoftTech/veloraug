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
    <div className="page-container max-w-3xl py-6 sm:py-8">
      <h1 className="text-headline-md md:text-headline-lg">VJs</h1>
      {vjs.length === 0 ? (
        <EmptyState icon={<Mic className="size-6" />} title="No VJs yet" description="VJs appear here once their titles are published." />
      ) : (
        <ul className="mt-6 rounded-lg border border-border bg-surface px-4 backdrop-blur-md md:px-6">
          {vjs.map((vj) => (
            <li key={vj.id} className="border-b border-border last:border-b-0">
              <Link href={`/vjs/${vj.slug}`} className="flex min-h-14 flex-col justify-center py-3 transition-colors hover:text-highlight">
                <span className="text-body-lg font-semibold">{vj.name}</span>
                {vj.description && <span className="mt-1 line-clamp-2 text-body-sm text-muted">{vj.description}</span>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
