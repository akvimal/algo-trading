import { useSearchParams } from "react-router-dom";
import { listIndicators, listRules, listSignals, listStrategies, listWatchlists } from "../api/strategies";
import { useResource } from "../hooks/useResource";
import { IndicatorsTab } from "./strategies/IndicatorsTab";
import { RulesTab } from "./strategies/RulesTab";
import { SignalsTab } from "./strategies/SignalsTab";
import { StrategiesTab } from "./strategies/StrategiesTab";
import { WatchlistsTab } from "./strategies/WatchlistsTab";

type Tab = "strategies" | "rules" | "indicators" | "watchlists" | "signals";
const TABS: { id: Tab; label: string }[] = [
  { id: "strategies", label: "Strategies" }, { id: "rules", label: "Rules" }, { id: "indicators", label: "Indicators" },
  { id: "watchlists", label: "Watchlists" }, { id: "signals", label: "Signals" },
];
const parseTab = (v: string | null): Tab => (TABS.some((t) => t.id === v) ? (v as Tab) : "strategies");

/** Authoring in-house strategies: what decides a signal fires (Rule, backed by Indicators and, for a
 * multi-symbol scan, a Watchlist), and what happens once it does (Strategy). Also takes an external
 * (webhook) provider's own strategies, which carry no rule at all. The four editors here cover the
 * common shapes; a multi-condition rule and a strategy's own exit condition still need the classic
 * app's term builder, and a rule's backtest stays there too for now — see docs/architecture.md. */
export function StrategiesPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  const set = (next: Tab) => setParams({ tab: next }, { replace: true });

  const strategies = useResource(listStrategies, []);
  const rules = useResource(listRules, []);
  const indicators = useResource(listIndicators, []);
  const watchlists = useResource(listWatchlists, []);
  const signals = useResource(() => listSignals(), [], { enabled: tab === "signals" });

  return (
    <div className="stack">
      <h1>Strategies</h1>
      <p className="faint" style={{ margin: 0 }}>
        What decides a signal fires, and what happens once it does. A multi-condition rule, a strategy's exit condition, and backtesting aren't editable here yet.
      </p>
      <div className="chips" role="tablist" aria-label="Strategy sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "strategies" && <StrategiesTab strategies={strategies} rules={rules} />}
      {tab === "rules" && <RulesTab rules={rules} indicators={indicators} watchlists={watchlists} />}
      {tab === "indicators" && <IndicatorsTab indicators={indicators} />}
      {tab === "watchlists" && <WatchlistsTab watchlists={watchlists} />}
      {tab === "signals" && <SignalsTab signals={signals} strategies={strategies.data ?? []} />}
    </div>
  );
}
