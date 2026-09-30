import { useMemo, useState } from "react";
import type { Position } from "../api/types";
import { applyLivePrices, liveSubscriptions, priceKey, type Applied, type Prices } from "../pages/liveModel";
import { useQuoteSocket } from "./useQuoteSocket";

const NONE: Applied["delta"] = {};

/** Open positions kept live by the price socket. While the socket is down (or before a price arrives) the
 * server's polled figures stand, so a dead socket costs freshness, never correctness. Pass undefined to
 * turn it off (a screen that is not showing positions). */
export function useLivePositions(positions: Position[] | undefined): Applied & { live: boolean } {
  const subs = useMemo(() => liveSubscriptions(positions ?? []), [positions]);
  const [pushed, setPushed] = useState<Prices>({});
  const socket = useQuoteSocket(positions ? subs : [], (t) => {
    const key = priceKey(t.exchange, t.symbol);
    setPushed((cur) => (cur[key] === t.price ? cur : { ...cur, [key]: t.price }));
  });
  const applied = useMemo<Applied>(() => (socket.connected && positions ? applyLivePrices(positions, pushed) : { positions: positions ?? [], delta: NONE }), [socket.connected, positions, pushed]);
  return { ...applied, live: socket.connected && positions != null };
}
