/**
 * The review overlay: the current site, the stream segments within the search
 * radius, and which one is matched.
 *
 * These layers are added straight to MapLibre rather than through
 * `registerExternalNativeLayer`, because they are transient review scaffolding
 * and should not appear in the Layers panel or be saved with the project. They
 * carry GeoLibre's `geolibre:internal` metadata flag so the host's own style
 * scans skip them.
 */
import type { Feature, FeatureCollection, LineString } from "geojson";
import type {
  GeoJSONSource,
  LayerSpecification,
  Map as MapLibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import type { Candidate, Segment, Site } from "./matching";

const CANDIDATES_SOURCE = "streamsnap-candidates";
const SELECTED_SOURCE = "streamsnap-selected";
const LINK_SOURCE = "streamsnap-link";
const SITE_SOURCE = "streamsnap-site";

/** Wide transparent line under the candidates, so segments are easy to hit. */
const HIT_LAYER = "streamsnap-candidates-hit";

const INTERNAL = { "geolibre:internal": true };

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export interface OverlayView {
  site: Site;
  segments: Segment[];
  candidates: Candidate[];
  /** Position in the segments array, or null when the site has no match. */
  selectedIndex: number | null;
  snapped: [number, number] | null;
}

export class MatchOverlay {
  private view: OverlayView | null = null;

  private readonly restyle = () => {
    // A basemap change rebuilds the style and drops these layers with it. Guard
    // on the layers actually being gone: `styledata` also fires for every
    // `setData` below, and re-rendering on those would loop forever.
    if (this.view && !this.map.getLayer(HIT_LAYER)) this.render(this.view);
  };

  private readonly handleClick = (event: MapMouseEvent) => {
    const feature = this.map.queryRenderedFeatures(event.point, { layers: [HIT_LAYER] })[0];
    const segmentIndex = feature?.properties?.segmentIndex;
    if (typeof segmentIndex === "number") this.onSelect(segmentIndex);
  };

  private readonly handleEnter = () => {
    this.map.getCanvas().style.cursor = "pointer";
  };

  private readonly handleLeave = () => {
    this.map.getCanvas().style.cursor = "";
  };

  constructor(
    private readonly map: MapLibreMap,
    private readonly onSelect: (segmentIndex: number) => void,
  ) {
    this.map.on("styledata", this.restyle);
    this.map.on("click", HIT_LAYER, this.handleClick);
    this.map.on("mouseenter", HIT_LAYER, this.handleEnter);
    this.map.on("mouseleave", HIT_LAYER, this.handleLeave);
  }

  render(view: OverlayView): void {
    this.view = view;
    this.ensureLayers();

    const candidates: Feature[] = view.candidates.map((candidate) => ({
      type: "Feature",
      geometry: view.segments[candidate.segmentIndex].feature.geometry,
      properties: { segmentIndex: candidate.segmentIndex },
    }));

    const selected =
      view.selectedIndex === null
        ? []
        : [
            {
              type: "Feature" as const,
              geometry: view.segments[view.selectedIndex].feature.geometry,
              properties: {},
            },
          ];

    const link: Feature<LineString>[] = view.snapped
      ? [
          {
            type: "Feature",
            geometry: { type: "LineString", coordinates: [view.site.lngLat, view.snapped] },
            properties: {},
          },
        ]
      : [];

    this.setData(CANDIDATES_SOURCE, candidates);
    this.setData(SELECTED_SOURCE, selected);
    this.setData(LINK_SOURCE, link);
    this.setData(SITE_SOURCE, [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: view.site.lngLat },
        properties: {},
      },
    ]);
  }

  clear(): void {
    this.view = null;
    for (const source of [CANDIDATES_SOURCE, SELECTED_SOURCE, LINK_SOURCE, SITE_SOURCE]) {
      this.setData(source, []);
    }
  }

  destroy(): void {
    this.map.off("styledata", this.restyle);
    this.map.off("click", HIT_LAYER, this.handleClick);
    this.map.off("mouseenter", HIT_LAYER, this.handleEnter);
    this.map.off("mouseleave", HIT_LAYER, this.handleLeave);
    this.map.getCanvas().style.cursor = "";

    for (const layer of [
      HIT_LAYER,
      "streamsnap-candidates-line",
      "streamsnap-selected-line",
      "streamsnap-link-line",
      "streamsnap-site-halo",
      "streamsnap-site-dot",
    ]) {
      if (this.map.getLayer(layer)) this.map.removeLayer(layer);
    }
    for (const source of [CANDIDATES_SOURCE, SELECTED_SOURCE, LINK_SOURCE, SITE_SOURCE]) {
      if (this.map.getSource(source)) this.map.removeSource(source);
    }
  }

  /** Bounding box covering the site and everything drawn around it. */
  static boundsFor(view: OverlayView): [number, number, number, number] {
    let [minX, minY] = view.site.lngLat;
    let [maxX, maxY] = view.site.lngLat;

    const extend = (lng: number, lat: number) => {
      minX = Math.min(minX, lng);
      maxX = Math.max(maxX, lng);
      minY = Math.min(minY, lat);
      maxY = Math.max(maxY, lat);
    };

    for (const candidate of view.candidates) extend(...candidate.snapped);
    if (view.snapped) extend(...view.snapped);
    return [minX, minY, maxX, maxY];
  }

  private setData(sourceId: string, features: Feature[]): void {
    const source = this.map.getSource<GeoJSONSource>(sourceId);
    source?.setData({ type: "FeatureCollection", features });
  }

  private ensureLayers(): void {
    for (const id of [CANDIDATES_SOURCE, SELECTED_SOURCE, LINK_SOURCE, SITE_SOURCE]) {
      if (!this.map.getSource(id)) this.map.addSource(id, { type: "geojson", data: EMPTY });
    }

    this.addLayer({
      id: HIT_LAYER,
      type: "line",
      source: CANDIDATES_SOURCE,
      paint: { "line-width": 18, "line-opacity": 0 },
    });
    this.addLayer({
      id: "streamsnap-candidates-line",
      type: "line",
      source: CANDIDATES_SOURCE,
      paint: { "line-color": "#f59e0b", "line-width": 3 },
    });
    this.addLayer({
      id: "streamsnap-selected-line",
      type: "line",
      source: SELECTED_SOURCE,
      paint: { "line-color": "#e11d48", "line-width": 5 },
    });
    this.addLayer({
      id: "streamsnap-link-line",
      type: "line",
      source: LINK_SOURCE,
      paint: { "line-color": "#111827", "line-width": 1.5, "line-dasharray": [2, 2] },
    });
    this.addLayer({
      id: "streamsnap-site-halo",
      type: "circle",
      source: SITE_SOURCE,
      paint: { "circle-radius": 9, "circle-color": "#ffffff", "circle-opacity": 0.9 },
    });
    this.addLayer({
      id: "streamsnap-site-dot",
      type: "circle",
      source: SITE_SOURCE,
      paint: { "circle-radius": 4.5, "circle-color": "#111827" },
    });
  }

  private addLayer(layer: LayerSpecification): void {
    if (this.map.getLayer(layer.id)) return;
    this.map.addLayer({ ...layer, metadata: INTERNAL });
  }
}
