import { useEffect, useState } from "react";
import { fetchTradeImageBlob } from "./api";

// A trade-screenshot <img> can't carry the Bearer header GET /images/{id}
// now requires (see api.ts's fetchTradeImageBlob comment) - this hook does
// the authenticated fetch and hands back a local blob: URL to use as
// `src` instead, revoking it on unmount/id-change so it doesn't leak.
export function useTradeImageSrc(id: string): string | null {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    fetchTradeImageBlob(id)
      .then((url) => {
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        objectUrl = url;
        setSrc(url);
      })
      .catch((err) => {
        console.error(`Failed to load trade image ${id}`, err);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      setSrc(null);
    };
  }, [id]);

  return src;
}
