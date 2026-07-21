/**
 * The Stacks brand lockup: the tiled favicon mark + wordmark + a subtitle.
 * Shared so every surface (sidebar, feed, …) renders it identically instead of
 * each page re-tuning its own sizes.
 */
export function Brand({ subtitle }: { subtitle: string }) {
  return (
    <>
      <img src="/favicon.svg" alt="" className="brand-logo" width={34} height={34} />
      <span className="brand-copy">
        <strong>Stacks</strong>
        <span className="brand-slogan">{subtitle}</span>
      </span>
    </>
  );
}
