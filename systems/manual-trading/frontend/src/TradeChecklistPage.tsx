import { useEffect, useState } from "react";

import {
  type ChecklistItem,
  type ChecklistPhase,
  type Segment,
  createChecklistItem,
  deleteChecklistItem,
  fetchChecklistItems,
  updateChecklistItem,
} from "./api";
import { CheckIcon, PencilIcon, TrashIcon, XIcon } from "./Icons";

const ALL_SEGMENTS: Segment[] = ["NSE", "MCX", "CRYPTO"];

// Intraday > Trade Checklist - the plan/day/review item editor
// (execution.checklist_items), split out of the old combined "Checklist &
// Risk Settings" page (see docs/architecture.md § "Manual Trading SaaS").
// Owns its own checklistItems fetch - WorkspacePage.tsx has its own
// independent copy too (dayItems, for its session check-in banner), since
// only one Intraday sub-page is ever mounted at a time.
export default function TradeChecklistPage() {
  const [checklistItems, setChecklistItems] = useState<ChecklistItem[]>([]);
  const planItems = checklistItems.filter((i) => i.phase === "plan");
  const reviewItems = checklistItems.filter((i) => i.phase === "review");
  const dayItems = checklistItems.filter((i) => i.phase === "day");

  const [newChecklistLabel, setNewChecklistLabel] = useState("");
  const [newChecklistPhase, setNewChecklistPhase] = useState<ChecklistPhase>("plan");
  const [newChecklistSegments, setNewChecklistSegments] = useState<Segment[]>([]);
  const [editingChecklistId, setEditingChecklistId] = useState<string | null>(null);
  const [editingChecklistLabel, setEditingChecklistLabel] = useState("");

  async function refreshChecklistItems() {
    try {
      setChecklistItems(await fetchChecklistItems());
    } catch {
      // leave the existing list as-is - the editor/checkboxes just show
      // whatever was last successfully fetched
    }
  }

  useEffect(() => {
    void refreshChecklistItems();
  }, []);

  return (
    <div className="manual-settings-page">
      <div className="manual-page-header">
        <h3>Trade Checklist</h3>
      </div>

      <section className="manual-settings-section">
        <h4>
          Trade discipline checklist ({checklistItems.length} item{checklistItems.length === 1 ? "" : "s"})
        </h4>
        {([
          ["plan", "Pre-trade (Plan)", planItems],
          ["day", "Once per day", dayItems],
          ["review", "Post-trade (Review)", reviewItems],
        ] as const).map(([phase, title, items]) => (
          <div className="manual-checklist-editor" key={phase}>
            <span className="manual-checklist-title">{title}</span>
            {items.map((item) => (
              <div className="manual-checklist-editor-row" key={item.id}>
                {editingChecklistId === item.id ? (
                  <>
                    <input type="text" value={editingChecklistLabel} onChange={(e) => setEditingChecklistLabel(e.target.value)} />
                    <span className="edit-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title="Save"
                        aria-label="Save"
                        onClick={async () => {
                          const label = editingChecklistLabel.trim();
                          if (!label) return;
                          await updateChecklistItem(item.id, { label });
                          setEditingChecklistId(null);
                          await refreshChecklistItems();
                        }}
                      >
                        <CheckIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn"
                        title="Cancel"
                        aria-label="Cancel"
                        onClick={() => setEditingChecklistId(null)}
                      >
                        <XIcon />
                      </button>
                    </span>
                  </>
                ) : (
                  <>
                    <span style={{ flex: 1 }}>{item.label}</span>
                    <span className="manual-segment-toggle-group" title="Which segment(s) this item applies to - none selected means every segment">
                      {ALL_SEGMENTS.map((seg) => (
                        <button
                          key={seg}
                          type="button"
                          className={`tiny secondary ${item.segments.includes(seg) ? "active" : ""}`}
                          onClick={async () => {
                            const segments = item.segments.includes(seg) ? item.segments.filter((s) => s !== seg) : [...item.segments, seg];
                            await updateChecklistItem(item.id, { segments });
                            await refreshChecklistItems();
                          }}
                        >
                          {seg[0]}
                        </button>
                      ))}
                    </span>
                    <span className="edit-actions">
                      <button
                        type="button"
                        className="icon-btn"
                        title={`Edit "${item.label}"`}
                        aria-label="Edit"
                        onClick={() => {
                          setEditingChecklistId(item.id);
                          setEditingChecklistLabel(item.label);
                        }}
                      >
                        <PencilIcon />
                      </button>
                      <button
                        type="button"
                        className="icon-btn danger"
                        title={`Remove "${item.label}"`}
                        aria-label="Remove"
                        onClick={async () => {
                          await deleteChecklistItem(item.id);
                          await refreshChecklistItems();
                        }}
                      >
                        <TrashIcon />
                      </button>
                    </span>
                  </>
                )}
              </div>
            ))}
            <div className="manual-checklist-editor-row">
              <input
                type="text"
                placeholder={`Add a${phase === "plan" ? " pre-trade" : phase === "day" ? " once-per-day" : " post-trade"} item...`}
                value={newChecklistPhase === phase ? newChecklistLabel : ""}
                onFocus={() => setNewChecklistPhase(phase)}
                onChange={(e) => {
                  setNewChecklistPhase(phase);
                  setNewChecklistLabel(e.target.value);
                }}
              />
              <span className="manual-segment-toggle-group" title="Which segment(s) the new item applies to - none selected means every segment">
                {ALL_SEGMENTS.map((seg) => (
                  <button
                    key={seg}
                    type="button"
                    className={`tiny secondary ${newChecklistPhase === phase && newChecklistSegments.includes(seg) ? "active" : ""}`}
                    onClick={() => {
                      setNewChecklistPhase(phase);
                      setNewChecklistSegments((prev) => (prev.includes(seg) ? prev.filter((s) => s !== seg) : [...prev, seg]));
                    }}
                  >
                    {seg[0]}
                  </button>
                ))}
              </span>
              <button
                type="button"
                className="tiny"
                disabled={newChecklistPhase !== phase || !newChecklistLabel.trim()}
                onClick={async () => {
                  const label = newChecklistLabel.trim();
                  if (!label) return;
                  setNewChecklistLabel("");
                  await createChecklistItem(label, phase, newChecklistSegments);
                  setNewChecklistSegments([]);
                  await refreshChecklistItems();
                }}
              >
                Add
              </button>
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
