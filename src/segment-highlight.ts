import type { ExpressionSpecification, Map as MapLibreMap } from "maplibre-gl";

type PaintProperty = "line-color" | "line-width";
type PaintOverride = {
  id: string;
  property: PaintProperty;
  original: unknown;
  applied: ExpressionSpecification;
};

/** Paint the selection in the stream's existing line layers. */
export class SegmentHighlight {
  private selection: { layerId: string; key: string; value: unknown } | null =
    null;
  private color = "#facc15";
  private width = 2;
  private updating = false;
  private overrides = new Map<string, PaintOverride>();

  constructor(private readonly map: MapLibreMap) {
    map.on("styledata", this.sync);
  }

  select(layerId: string, key: string, value: unknown): void {
    if (value == null || this.selection?.layerId !== layerId) this.clear();
    this.selection = value == null ? null : { layerId, key, value };
    this.sync();
  }

  setStyle(color: string, width: number): void {
    this.color = color;
    this.width = width;
    this.sync();
  }

  clear(): void {
    this.selection = null;
    for (const { id, property, original, applied } of this.overrides.values()) {
      if (
        this.map.getLayer(id) &&
        equal(this.map.getPaintProperty(id, property), applied)
      ) {
        this.map.setPaintProperty(id, property, original ?? null);
      }
    }
    this.overrides.clear();
  }

  destroy(): void {
    this.map.off("styledata", this.sync);
    this.clear();
  }

  private readonly sync = (): void => {
    if (!this.selection || this.updating) return;
    const { layerId, key, value } = this.selection;
    const condition: ExpressionSpecification = [
      "==",
      ["get", key],
      ["literal", value],
    ];
    this.updating = true;
    try {
      for (const layer of this.map.getStyle().layers) {
        // GeoLibre's native GeoJSON and Vector Control source IDs.
        if (
          layer.type !== "line" ||
          (layer.source !== `source-${layerId}` &&
            layer.source !== `${layerId}-source`)
        )
          continue;
        for (const property of ["line-color", "line-width"] as const) {
          const id = layer.id;
          const overrideKey = `${id}/${property}`;
          const current = this.map.getPaintProperty(id, property);
          const saved = this.overrides.get(overrideKey);
          // Keep host style edits as the base to restore after selection.
          const original =
            saved && equal(current, saved.applied) ? saved.original : current;
          const color = property === "line-color";
          const applied = selectedPaint(
            original ?? (color ? "#000000" : 1),
            condition,
            color ? this.color : this.width,
          );
          this.overrides.set(overrideKey, { id, property, original, applied });
          if (!equal(current, applied))
            this.map.setPaintProperty(id, property, applied);
        }
      }
    } finally {
      this.updating = false;
    }
  };
}

function equal(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function selectedPaint(
  base: unknown,
  condition: ExpressionSpecification,
  value: string | number,
): ExpressionSpecification {
  // MapLibre requires zoom to remain in the outer step/interpolate expression.
  if (Array.isArray(base)) {
    const inputIndex = base[0] === "step" ? 1 : 2;
    if (equal(base[inputIndex], ["zoom"])) {
      return base.map((part, i) =>
        i > inputIndex && i % 2 === 0
          ? selectedPaint(part, condition, value)
          : part,
      ) as ExpressionSpecification;
    }
  }
  return ["case", condition, value, base] as ExpressionSpecification;
}
