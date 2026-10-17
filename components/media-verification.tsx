import type { ReactNode } from "react";
import { Check, Circle, CircleHelp, TriangleAlert, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { MediaReport, MediaTone } from "@/lib/discovery/media-report";

const TONE: Record<MediaTone, { icon: typeof Check; className: string }> = {
  verified: { icon: Check, className: "border-highlight/40 bg-accent/12 text-highlight" },
  pending: { icon: Circle, className: "border-border text-foreground" },
  warning: { icon: TriangleAlert, className: "border-border text-foreground" },
  failed: { icon: X, className: "border-destructive text-destructive" },
  missing: { icon: CircleHelp, className: "border-border text-muted" },
};

/**
 * One file's inspection for a reviewer: the separate statuses, what was read
 * from the file, and why a check did not pass. It shows what the database
 * recorded and decides nothing. `id` keeps headings unique on a page.
 */
export function MediaVerification({ report, id = "media", children }: { report: MediaReport; id?: string; children?: ReactNode }) {
  return <section aria-labelledby={`${id}-heading`} className="min-w-0 rounded-lg border border-border p-5">
    <h2 id={`${id}-heading`} className="text-headline-sm">Media inspection</h2>
    <p className="mt-1 text-body-sm text-muted">{report.basis}</p>
    <ul className="mt-4 grid gap-3 sm:grid-cols-2">{report.statuses.map((status) => { const tone = TONE[status.tone]; return <li key={status.label} className="min-w-0 rounded-lg border border-border bg-surface p-4">
      <p className="text-label-md text-muted">{status.label}</p>
      <p className={cn("mt-2 inline-flex max-w-full items-start gap-2 rounded-lg border px-3 py-1 text-label-md", tone.className)}>
        <tone.icon aria-hidden className="mt-0.5 size-4 shrink-0" /><span className="min-w-0 break-words">{status.value}</span>
      </p>
      <p className="mt-2 break-words text-body-sm text-muted">{status.detail}</p>
    </li>; })}</ul>
    <dl className="mt-4 grid grid-cols-1 gap-2 break-words text-body-md sm:grid-cols-2">
      {[...report.details, ...report.provenance].map((detail) => <div key={detail.label} className="contents"><dt className="text-muted">{detail.label}</dt><dd className="min-w-0 break-all">{detail.value}</dd></div>)}
      {children}
    </dl>
    {report.reasons.length > 0 && <div className="mt-4">
      <h3 className="text-label-lg">Why the inspection did not pass</h3>
      <ul className="mt-2 list-inside list-disc space-y-1 text-body-md">{report.reasons.map((reason) => <li key={reason}>{reason}</li>)}</ul>
    </div>}
    {report.history.length > 0 && <div className="mt-4">
      <h3 className="text-label-lg">Historical result (not a current verdict)</h3>
      <ul className="mt-2 list-inside list-disc space-y-1 text-body-md text-muted">{report.history.map((entry) => <li key={entry}>{entry}</li>)}</ul>
    </div>}
    {report.warnings.length > 0 && <div className="mt-4">
      <h3 className="text-label-lg">Playback warnings</h3>
      <ul className="mt-2 list-inside list-disc space-y-1 text-body-md">{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>
      <p className="mt-2 text-body-sm text-muted">Warnings describe playback in a browser. They do not block publication.</p>
    </div>}
    {report.browsers.length > 0 && <details className="mt-4 rounded-lg border border-border p-4">
      <summary className="cursor-pointer text-label-lg">Browser by browser</summary>
      <dl className="mt-3 grid grid-cols-1 gap-2 text-body-md sm:grid-cols-2">{report.browsers.map((browser) => <div key={browser.name} className="contents"><dt className="text-muted">{browser.name}</dt><dd>{browser.value}</dd></div>)}</dl>
    </details>}
  </section>;
}
