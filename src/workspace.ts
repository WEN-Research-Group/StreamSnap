/**
 * Reading the vector layers the user already has loaded in GeoLibre.
 *
 * GeoLibre's plugin API has no "list the workspace layers" call, so this module
 * derives the list from the two things the host does expose: the MapLibre style
 * (via `app.getMap()`) and `window.__GEOLIBRE_LAYER_LABELS__`, the style-layer-id
 * to display-name bridge the host publishes on every layer change. Everything
 * that depends on GeoLibre's internal id conventions is confined to this file.
 */
import type { GeoJSONSource, LayerSpecification, Map as MapLibreMap } from "maplibre-gl";
import type { VectorCollection } from "./matching";


/** GeoLibre names a vector layer's MapLibre source `source-<layerId>`. */
const SOURCE_PREFIX = "source-";

/**
 * Sources derived from a layer's main source (dedup labels, inverted-fill mask,
 * geometry-generator output). They mirror the parent's id, so they must not be
 * offered as layers of their own.
 */
const DERIVED_SOURCE_SUFFIXES = ["-label", "-inverted", "-generator"];

export type WorkspaceGeometry = "point" | "line" | "polygon";

export interface WorkspaceLayer {
  /** GeoLibre's own layer id (the uuid embedded in the source id). */
  layerId: string;
  sourceId: string;
  name: string;
  geometry: WorkspaceGeometry;
  /**
   * True when the layer renders from client-side vector tiles rather than an
   * in-memory GeoJSON source, which GeoLibre switches to above 50,000 features.
   * That tile data is private to the host, so such a layer cannot be read.
   */
  tiled: boolean;
}

interface LayerLabelWindow extends Window {
  __GEOLIBRE_LAYER_LABELS__?: Record<string, string>;
}

/** Event the host dispatches whenever the published layer names change. */
const LABELS_CHANGED_EVENT = "geolibre-layer-labels-change";

/**
 * The vector layers currently loaded in the workspace, sorted by name.
 *
 * A layer is included only when the host published a display name for one of
 * its style layers, which is exactly the set the user sees in the Layers panel.
 */
export function listWorkspaceVectorLayers(map: MapLibreMap): WorkspaceLayer[] {
  const style = map.getStyle();
  const labels = (window as LayerLabelWindow).__GEOLIBRE_LAYER_LABELS__ ?? {};
  const bySource = new Map<string, { types: Set<string>; name: string }>();

  for (const styleLayer of style?.layers ?? []) {
    const source = "source" in styleLayer ? styleLayer.source : undefined;
    if (typeof source !== "string" || isInternal(styleLayer)) continue;

    const label = labels[styleLayer.id];
    if (!label) continue;

    const entry = bySource.get(source) ?? { types: new Set<string>(), name: label };
    entry.types.add(styleLayer.type);
    // A layer drawn through several style layers gets suffixed labels ("Rivers
    // line", "Rivers fill"); the bare layer name is the shortest of them.
    if (label.length < entry.name.length) entry.name = label;
    bySource.set(source, entry);
  }

  const layers: WorkspaceLayer[] = [];
  for (const [sourceId, entry] of bySource) {
    if (!sourceId.startsWith(SOURCE_PREFIX)) continue;
    if (DERIVED_SOURCE_SUFFIXES.some((suffix) => sourceId.endsWith(suffix))) continue;

    const spec = style?.sources?.[sourceId];
    if (spec?.type !== "geojson" && spec?.type !== "vector") continue;

    const geometry = classifyGeometry(entry.types);
    if (!geometry) continue;

    layers.push({
      layerId: sourceId.slice(SOURCE_PREFIX.length),
      sourceId,
      name: entry.name,
      geometry,
      tiled: spec.type === "vector",
    });
  }

  return layers.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Read a workspace layer's full GeoJSON straight from its MapLibre source.
 * Only ever called for a `tiled: false` layer, whose source GeoLibre always
 * populates with a FeatureCollection.
 */
export async function readWorkspaceLayer(
  map: MapLibreMap,
  layer: WorkspaceLayer,
): Promise<VectorCollection> {
  const source = map.getSource<GeoJSONSource>(layer.sourceId)!;
  return (await source.getData()) as VectorCollection;
}

/** Run `listener` whenever the set of loaded layers may have changed. */
export function onWorkspaceChange(map: MapLibreMap, listener: () => void): () => void {
  window.addEventListener(LABELS_CHANGED_EVENT, listener);
  map.on("styledata", listener);
  return () => {
    window.removeEventListener(LABELS_CHANGED_EVENT, listener);
    map.off("styledata", listener);
  };
}

/**
 * Infer a layer's geometry from the style layers drawing it. Order matters: a
 * polygon layer also carries an outline `line` layer, and a line layer can
 * carry a `symbol` decoration layer, so the more specific tests come first.
 */
function classifyGeometry(types: Set<string>): WorkspaceGeometry | null {
  if (types.has("fill") || types.has("fill-extrusion")) return "polygon";
  if (types.has("circle") || types.has("heatmap")) return "point";
  if (types.has("line")) return "line";
  if (types.has("symbol")) return "point";
  return null;
}

/** GeoLibre tags its own helper style layers so they can be skipped. */
function isInternal(styleLayer: LayerSpecification): boolean {
  const metadata: unknown = styleLayer.metadata;
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    (metadata as Record<string, unknown>)["geolibre:internal"] === true
  );
}
