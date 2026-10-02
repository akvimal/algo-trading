// A stand-in for the chart library, installed for every test (jsdom has no canvas). It never draws
// anything; it records what the app asks of the chart, so a test can say "the stop line was drawn at 990"
// or "the indicator pane was removed" without a real chart. Only the surface the app uses is here.

export enum ActionType {
  OnZoom = "onZoom",
  OnScroll = "onScroll",
  OnVisibleRangeChange = "onVisibleRangeChange",
  OnCandleBarClick = "onCandleBarClick",
  OnCrosshairChange = "onCrosshairChange",
}
export enum OverlayMode {
  Normal = "normal",
  WeakMagnet = "weak_magnet",
  StrongMagnet = "strong_magnet",
}
export enum IndicatorSeries {
  Normal = "normal",
  Price = "price",
  Volume = "volume",
}
export enum LineType {
  Solid = "solid",
  Dashed = "dashed",
}

export type FakeBar = { timestamp: number; open: number; high: number; low: number; close: number; volume?: number };
export type FakeOverlay = { id: string; name: string; groupId?: string; points: any[]; extendData?: any; visible?: boolean; mode?: string; styles?: any; handlers: Record<string, (e: any) => any> };

export const registeredOverlays: string[] = [];
export const registeredIndicators: string[] = [];
export const registerOverlay = (o: { name: string }) => void registeredOverlays.push(o.name);
export const registerIndicator = (i: { name: string }) => void registeredIndicators.push(i.name);

export class FakeChart {
  static instances: FakeChart[] = [];
  static disposed = 0;

  el: HTMLElement;
  styles: unknown;
  data: FakeBar[] = [];
  applyCalls = 0;
  updates: FakeBar[] = [];
  overlays = new Map<string, FakeOverlay>();
  removedOverlayCalls: unknown[] = [];
  indicators = new Map<string, { paneId: string; value: unknown; stack: boolean }>();
  removedIndicators: string[] = [];
  overrides: unknown[] = [];
  subs = new Map<string, Set<(d?: unknown) => void>>();
  barSpace = 8;
  scrolledTo: number[] = [];
  scrolledIndex: number[] = [];
  precision: [number, number] | null = null;
  private seq = 0;

  constructor(el: HTMLElement, styles: unknown) {
    this.el = el;
    this.styles = styles;
    FakeChart.instances.push(this);
  }

  static reset() {
    FakeChart.instances = [];
    FakeChart.disposed = 0;
  }
  static get last(): FakeChart | undefined {
    return FakeChart.instances[FakeChart.instances.length - 1];
  }

  // ---- the surface the app calls ----
  applyNewData(bars: FakeBar[]) {
    this.applyCalls += 1;
    this.data = [...bars];
  }
  updateData(bar: FakeBar) {
    this.updates.push(bar);
    const last = this.data[this.data.length - 1];
    if (last && last.timestamp === bar.timestamp) this.data[this.data.length - 1] = bar;
    else if (!last || bar.timestamp > last.timestamp) this.data.push(bar);
  }
  getDataList() {
    return this.data;
  }
  setPriceVolumePrecision(price: number, volume: number) {
    this.precision = [price, volume];
  }
  resize() {}
  setStyles(s: unknown) {
    this.styles = s;
  }
  getVisibleRange() {
    return { from: 0, to: this.data.length, realFrom: 0, realTo: this.data.length };
  }
  getBarSpace() {
    return this.barSpace;
  }
  setBarSpace(n: number) {
    this.barSpace = n;
  }
  scrollToDataIndex(i: number) {
    this.scrolledIndex.push(i);
  }
  scrollToTimestamp(ts: number) {
    this.scrolledTo.push(ts);
  }
  convertToPixel(point: { value?: number }) {
    return { x: 120, y: 1000 - (point.value ?? 0) };
  }
  convertFromPixel(coords: { y?: number }[]) {
    return coords.map((c) => ({ value: 1000 - (c.y ?? 0) }));
  }

  createOverlay(o: any) {
    const id = `ov${++this.seq}`;
    this.overlays.set(id, { id, name: o.name, groupId: o.groupId, points: o.points ?? [], extendData: o.extendData, mode: o.mode, styles: o.styles, handlers: o });
    return id;
  }
  overrideOverlay(o: any) {
    const cur = this.overlays.get(o.id);
    if (cur) Object.assign(cur, { ...(o.points ? { points: o.points } : {}), ...(o.extendData ? { extendData: o.extendData } : {}), ...(o.visible !== undefined ? { visible: o.visible } : {}), ...(o.mode ? { mode: o.mode } : {}) });
    if (cur && o.styles) {
      const merged: Record<string, unknown> = { ...((cur as any).styles ?? {}) };
      for (const k of Object.keys(o.styles)) merged[k] = { ...(merged[k] as object), ...o.styles[k] };
      (cur as any).styles = merged;
    }
    this.overrides.push(o);
  }
  removeOverlay(arg?: string | { groupId?: string; id?: string }) {
    this.removedOverlayCalls.push(arg);
    const drop = (id: string) => {
      const ov = this.overlays.get(id);
      this.overlays.delete(id);
      ov?.handlers.onRemoved?.({ overlay: { id, name: ov.name, points: ov.points } });
    };
    if (arg === undefined) [...this.overlays.keys()].forEach(drop);
    else if (typeof arg === "string") drop(arg);
    else if (arg.groupId) [...this.overlays.values()].filter((o) => o.groupId === arg.groupId).forEach((o) => drop(o.id));
    else if (arg.id) drop(arg.id);
  }

  createIndicator(value: unknown, stack: boolean, pane?: { id?: string }) {
    const name = typeof value === "string" ? value : (value as { name: string }).name;
    const paneId = pane?.id ?? `pane_${name}`;
    this.indicators.set(name, { paneId, value, stack });
    return paneId;
  }
  removeIndicator(paneId: string, name: string) {
    this.removedIndicators.push(name);
    this.indicators.delete(name);
    void paneId;
  }
  overrideIndicator(v: { name: string; calcParams?: number[] }) {
    const cur = this.indicators.get(v.name);
    if (cur) cur.value = v;
    this.overrides.push(v);
  }

  subscribeAction(type: string, cb: (d?: unknown) => void) {
    if (!this.subs.has(type)) this.subs.set(type, new Set());
    this.subs.get(type)!.add(cb);
  }
  unsubscribeAction(type: string, cb: (d?: unknown) => void) {
    this.subs.get(type)?.delete(cb);
  }

  // ---- test controls ----
  emit(type: string, data?: unknown) {
    this.subs.get(type)?.forEach((cb) => cb(data));
  }
  overlaysNamed(name: string) {
    return [...this.overlays.values()].filter((o) => o.name === name);
  }
  /** Finish drawing the pending overlay the way the library would, at the given points. */
  finishDrawing(id: string, points: any[]) {
    const ov = this.overlays.get(id);
    if (!ov) return;
    ov.points = points;
    ov.handlers.onDrawEnd?.({ overlay: { id, name: ov.name, points } });
  }
  getOverlayById(id: string) {
    const ov = this.overlays.get(id);
    return ov ? { id, name: ov.name, points: ov.points, extendData: ov.extendData } : null;
  }
  /** Press a drawing and drag it, WITHOUT the library reporting the release (the mouse was let go outside the plot area). */
  dragOverlayWithoutRelease(id: string, points: any[]) {
    const ov = this.overlays.get(id);
    if (!ov) return;
    ov.handlers.onPressedMoveStart?.({ overlay: { id, name: ov.name, points: ov.points } });
    ov.points = points;
    ov.handlers.onPressedMoving?.({ overlay: { id, name: ov.name, points } });
  }
  moveOverlay(id: string, points: any[]) {
    const ov = this.overlays.get(id);
    if (!ov) return;
    ov.points = points;
    ov.handlers.onPressedMoveEnd?.({ overlay: { id, name: ov.name, points } });
  }
  doubleClick(id: string) {
    const ov = this.overlays.get(id);
    ov?.handlers.onDoubleClick?.({ overlay: { id, name: ov.name, points: ov.points, extendData: ov.extendData } });
  }
  select(id: string) {
    const ov = this.overlays.get(id);
    ov?.handlers.onSelected?.({ overlay: { id, name: ov.name, points: ov.points } });
  }
}

export const init = (el: HTMLElement, opts?: { styles?: unknown }) => new FakeChart(el, opts?.styles);
export const dispose = () => {
  FakeChart.disposed += 1;
};
