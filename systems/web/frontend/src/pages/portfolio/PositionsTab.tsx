import type { OptionGroup, Position } from "../../api/types";
import type { Resource } from "../../hooks/useResource";
import { Empty, ErrorNotice, Skeleton } from "../../components/bits";
import { PositionCard } from "../../components/PositionCard";
import { openGroups, openPositions } from "../todayModel";

export function PositionsTab({ open }: { open: Resource<{ positions: Position[]; groups: OptionGroup[] }> }) {
  if (open.loading) return <Skeleton lines={4} />;
  if (open.error && !open.data) return <ErrorNotice error={open.error} onRetry={open.reload} />;
  if (!open.data) return null;
  const positions = openPositions(open.data.positions);
  const groups = openGroups(open.data.groups);
  return (
    <div className="stack">
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
