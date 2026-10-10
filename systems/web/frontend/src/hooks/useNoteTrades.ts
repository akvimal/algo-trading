import { useCallback, useEffect, useMemo, useState } from "react";
import { getNoteTrades, type NoteTrade } from "../api/planTrade";
import type { StudyNote } from "../api/types";

/** Where each plan note's trade stands, by note id. Only plan notes are asked about; a note with no trade is absent from the map.
 * A failed lookup just leaves the notes without a status (the notes themselves are unaffected). `reload` asks again, after a trade is
 * placed or an order cancelled. */
export function useNoteTrades(notes: StudyNote[]): { byId: Record<string, NoteTrade>; reload: () => void } {
  const [byId, setById] = useState<Record<string, NoteTrade>>({});
  const [tick, setTick] = useState(0);
  const ids = useMemo(() => notes.filter((n) => n.tag === "plan").map((n) => n.id), [notes]);
  const key = ids.join(",");

  useEffect(() => {
    if (!key) {
      setById({});
      return;
    }
    let live = true;
    getNoteTrades(key.split(","))
      .then((rows) => live && setById(Object.fromEntries(rows.map((r) => [r.note_id, r]))))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [key, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { byId, reload };
}
