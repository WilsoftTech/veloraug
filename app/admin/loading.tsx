import { EmptyState } from "@/components/empty-state";

export default function Loading() {
  return (
    <div aria-busy="true">
      <EmptyState title="Loading" />
    </div>
  );
}
