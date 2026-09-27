import { Link, useSearchParams } from "react-router-dom";
import { getAccounts, getCredentials } from "../api/settings";
import type { Segment } from "../api/types";
import { ErrorNotice, Skeleton } from "../components/bits";
import { SEGMENTS } from "../config";
import { useResource } from "../hooks/useResource";
import { AdvancedSection } from "./settings/AdvancedSection";
import { BrokerSection } from "./settings/BrokerSection";
import { RiskSection } from "./settings/RiskSection";

const TABS = [
  { id: "risk", label: "Risk limits" },
  { id: "broker", label: "Broker & live" },
  { id: "advanced", label: "Advanced" },
] as const;
type TabId = (typeof TABS)[number]["id"];

const SEGMENT_LABEL: Record<Segment, string> = { NSE: "Stocks & F&O", MCX: "Commodities", CRYPTO: "Crypto" };

const parseTab = (v: string | null): TabId => (TABS.some((t) => t.id === v) ? (v as TabId) : "risk");
const parseSegment = (v: string | null): Segment => ((SEGMENTS as readonly string[]).includes(v ?? "") ? (v as Segment) : "NSE");

export function SettingsPage() {
  const [params, setParams] = useSearchParams();
  const tab = parseTab(params.get("tab"));
  const segment = parseSegment(params.get("segment"));
  const set = (next: Record<string, string>) => setParams({ tab, segment, ...next }, { replace: true });

  const accounts = useResource(getAccounts, []);
  const creds = useResource(getCredentials, []);
  const account = accounts.data?.find((a) => a.segment === segment);

  return (
    <div className="stack">
      <p style={{ margin: 0 }}>
        <Link to="/more">← More</Link>
      </p>
      <h1>Settings</h1>
      <div className="chips" role="tablist" aria-label="Settings sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => set({ tab: t.id })}>
            {t.label}
          </button>
        ))}
      </div>

      {accounts.loading && <Skeleton lines={5} />}
      {accounts.error && !accounts.data && <ErrorNotice error={accounts.error} onRetry={accounts.reload} />}

      {tab === "risk" && accounts.data && (
        <>
          <div className="chips" role="group" aria-label="Account">
            {SEGMENTS.map((s) => (
              <button key={s} aria-pressed={segment === s} onClick={() => set({ segment: s })}>
                {SEGMENT_LABEL[s]}
              </button>
            ))}
          </div>
          {account ? <RiskSection account={account} onSaved={accounts.reload} /> : <p className="dim">No account for this segment yet.</p>}
        </>
      )}

      {tab === "broker" && accounts.data && <BrokerSection creds={creds} accounts={accounts.data} onAccountSaved={accounts.reload} />}
      {tab === "advanced" && <AdvancedSection />}
    </div>
  );
}
