import Image from "next/image";
import { cn } from "@/lib/utils";

interface MediaImageProps {
  /** TMDB image path (e.g. "/abc.jpg"), or null when the title has no artwork. */
  path: string | null;
  title: string;
  sizes: string;
  /** Alt text. Leave empty when the title is already rendered next to the image. */
  alt?: string;
  /** Reserve for the single most important above-the-fold image. */
  preload?: boolean;
  /** Skip lazy loading for images that are certainly visible on first paint. */
  eager?: boolean;
  className?: string;
}

// A stable per-title hue, kept inside the blue family so artwork-less cards
// stay on-brand without any assets.
function hueFor(title: string) {
  let hash = 0;
  for (const char of title) hash = (hash * 31 + char.charCodeAt(0)) % 40;
  return 200 + hash;
}

export function PosterImage({ path, title, sizes, alt = "", preload, eager, className }: MediaImageProps) {
  const hue = hueFor(title);
  return (
    <div className={cn("relative aspect-[2/3] overflow-hidden rounded-lg bg-canvas-subtle", className)}>
      {path ? (
        <Image
          src={path}
          alt={alt}
          fill
          sizes={sizes}
          preload={preload}
          loading={eager ? "eager" : undefined}
          className="object-cover"
        />
      ) : (
        <div
          className="flex size-full items-end p-3"
          style={{ backgroundImage: `linear-gradient(160deg, hsl(${hue} 55% 24%), hsl(${hue + 15} 60% 8%))` }}
        >
          <span className="line-clamp-4 text-label-lg text-foreground/90">{title}</span>
        </div>
      )}
    </div>
  );
}

/** Fills its (relatively positioned) parent; the parent controls the height. */
export function BackdropImage({ path, sizes, alt = "", preload, className }: Omit<MediaImageProps, "title">) {
  if (!path) {
    return (
      <div
        aria-hidden
        className={cn(
          "absolute inset-0 bg-canvas-subtle bg-[radial-gradient(ellipse_at_70%_20%,rgb(229_9_20/0.25),transparent_60%)]",
          className,
        )}
      />
    );
  }
  return (
    <Image
      src={path}
      alt={alt}
      fill
      sizes={sizes}
      preload={preload}
      className={cn("object-cover object-[50%_20%]", className)}
    />
  );
}
