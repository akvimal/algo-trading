import type { OptionGroup, Position } from "../../api/types";
import type { Resource } from "../../hooks/useResource";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { PositionCard } from "../../components/PositionCard";
import { openGroups, openPositions } from "../todayModel";

/** `positions` are the open ones valued at live prices, when the price socket is up; otherwise the polled ones. */
export function PositionsTab({ open, positions: livePositions, live = false }: { open: Resource<{ positions: Position[]; groups: OptionGroup[] }>; positions?: Position[]; live?: boolean }) {
  if (open.loading) return <Skeleton lines={4} />;
  if (open.error && !open.data) return <ErrorNotice error={open.error} onRetry={open.reload} />;
  if (!open.data) return null;
  const positions = openPositions(livePositions ?? open.data.positions);
  const groups = openGroups(open.data.groups);
  return (
    <div className="stack">
      {live && (
        <span className="faint" data-testid="live-positions" style={{ fontSize: 12 }}>
          <span className="live-dot on">
            <span className="sr-only">Live</span>
          </span>{" "}
          Live: results update as prices move
        </span>
      )}
      {open.error && <ErrorNotice error={open.error} onRetry={open.reload} />}
      {positions.length + groups.length === 0 ? (
        <Empty title="Nothing open on this account">Trades you place appear here with their live profit or loss.</Empty>
      ) : (
        <>
          {positions.map((p) => (
            <PositionCard key={p.id} kind="position" item={p} onChanged={open.reload} />
          ))}
          {groups.map((g) => (
            <PositionCard key={g.id} kind="group" item={g} onChanged={open.reload} />
          ))}
        </>
      )}
    </div>
  );
}
