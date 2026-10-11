import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AdminNav } from "@/components/admin-nav";
import { requireReviewAdmin } from "@/lib/discovery/runtime";

export const metadata: Metadata = { title: "Admin", robots: { index: false } };

/** The admin shell. Each page and action still checks authorization itself; this only frames them. */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireReviewAdmin();
  return (
    <div className="page-container py-6 sm:py-8">
      <p className="text-label-md text-muted">Velora UG admin</p>
      <div className="mt-2">
        <AdminNav />
      </div>
      <div className="mt-6">{children}</div>
    </div>
  );
}
