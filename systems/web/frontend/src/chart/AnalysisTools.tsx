import { IndicatorsPanel } from "./IndicatorMenu";
import { Popover } from "./Popover";
import { StructurePanel } from "./StructureMenu";
import { IndicatorsIcon, StructureIcon } from "./icons";
import type { StructureConfig } from "./config";

type Props = {
  selected: string[];
  onSelected: (names: string[]) => void;
  params: Record<string, number[]>;
  onParams: (p: Record<string, number[]>) => void;
  indicatorsHidden: boolean;
  onIndicatorsHidden: (h: boolean) => void;
  structure: StructureConfig;
  onStructure: (c: StructureConfig) => void;
  structureOn: boolean;
  onStructureOn: (on: boolean) => void;
};

/** The analysis group at the bottom of the chart rail: Indicators and Structure, each an icon button that opens its panel
 * beside the rail. Indicators shows how many are on; Structure is highlighted while the layer is on and counts its
 * detection intervals. Hiding all indicators is a switch inside the Indicators panel (the rail's own eye hides drawings). */
export function AnalysisTools(p: Props) {
  return (
    <div className="rail-group" role="group" aria-label="Analysis">
      <Popover label="Indicators" variant="tool" side="beside" icon={<IndicatorsIcon />} badge={p.selected.length} pressed={p.selected.length > 0 && !p.indicatorsHidden} title="Indicators">
        <IndicatorsPanel selected={p.selected} onSelected={p.onSelected} params={p.params} onParams={p.onParams} hidden={p.indicatorsHidden} onHidden={p.onIndicatorsHidden} />
      </Popover>
      <Popover label="Structure" variant="tool" side="beside" icon={<StructureIcon />} badge={p.structureOn ? p.structure.tfs.length : undefined} pressed={p.structureOn} title="Structure: order blocks, fair value gaps, breaks of structure">
        <StructurePanel config={p.structure} onChange={p.onStructure} on={p.structureOn} onOn={p.onStructureOn} />
      </Popover>
    </div>
  );
}
