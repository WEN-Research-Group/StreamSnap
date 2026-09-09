import type { Feature, Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "./host-api";

export type WorkspaceGeometry = "point" | "line";

export interface WorkspaceLayer {
  layerId: string;
  name: string;
  geometry: WorkspaceGeometry;
}

export function listWorkspaceVectorLayers(
  app: GeoLibreAppAPI,
): WorkspaceLayer[] {
  const layers: WorkspaceLayer[] = [];

  for (const layer of app.listLayers()) {
    const type = app
      .getLayerFeatures(layer.id)
      .find((feature) => feature.geometry)?.geometry?.type;
    const geometry =
      type === "Point"
        ? "point"
        : type === "LineString" || type === "MultiLineString"
          ? "line"
          : null;
    if (geometry) {
      layers.push({ layerId: layer.id, name: layer.name, geometry });
    }
  }

  return layers.sort((a, b) => a.name.localeCompare(b.name));
}

export function readWorkspaceLayer(
  app: GeoLibreAppAPI,
  layer: WorkspaceLayer,
): Feature<Geometry | null>[] {
  return app.getLayerFeatures(layer.layerId);
}

export function onWorkspaceChange(
  map: MapLibreMap,
  listener: () => void,
): () => void {
  map.on("styledata", listener);
  map.on("idle", listener);
  return () => {
    map.off("styledata", listener);
    map.off("idle", listener);
  };
}
