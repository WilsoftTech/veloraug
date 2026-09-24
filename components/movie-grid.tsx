import { MovieCard } from "@/components/movie-card";
import type { TitleSummary } from "@/types/catalogue";

const GRID_POSTER_SIZES =
  "(min-width: 1280px) 15vw, (min-width: 1024px) 19vw, (min-width: 768px) 24vw, (min-width: 640px) 32vw, 48vw";

// Six columns is the widest layout, so the first six posters are always above the fold.
const FIRST_ROW_COUNT = 6;

export function MovieGrid({ items }: { items: TitleSummary[] }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-8 sm:grid-cols-3 md:grid-cols-4 md:gap-x-6 lg:grid-cols-5 xl:grid-cols-6">
      {items.map((item, index) => (
        <li key={`${item.kind}-${item.id}`}>
          <MovieCard item={item} sizes={GRID_POSTER_SIZES} eager={index < FIRST_ROW_COUNT} />
        </li>
      ))}
    </ul>
  );
}
