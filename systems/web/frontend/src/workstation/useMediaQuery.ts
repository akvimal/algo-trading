import { useEffect, useState } from "react";

/** True while the query matches, and it follows the window as it is resized or rotated. Where the
 * browser has no matchMedia (some test environments) it reports false. */
export function useMediaQuery(query: string): boolean {
  const get = () => {
    try {
      return window.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  };
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener?.("change", onChange);
    return () => mq.removeEventListener?.("change", onChange);
  }, [query]);
  return matches;
}

/** The width at which the workstation can lay charts out side by side with a tool strip. */
export const WIDE_QUERY = "(min-width: 900px)";
