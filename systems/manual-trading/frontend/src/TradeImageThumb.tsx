import { useTradeImageSrc } from "./useTradeImageSrc";

// The <a href>/<img src> pair used to point straight at
// tradeImageUrl(id) - GET /images/{id} now requires a Bearer token (see
// api.ts's fetchTradeImageBlob comment), which neither a browser-navigated
// href nor a plain img src can carry, so both now render off the same
// fetched blob: URL instead (a blob: URL needs no auth - it's already-
// fetched local data, so "open full size in a new tab" keeps working).
export default function TradeImageThumb({ id }: { id: string }) {
  const src = useTradeImageSrc(id);
  if (!src) return null;
  return (
    <a href={src} target="_blank" rel="noreferrer">
      <img src={src} alt="attached chart" loading="lazy" />
    </a>
  );
}
