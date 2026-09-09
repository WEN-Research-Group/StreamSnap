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
const HIT_LAYER = "streamsnap-candidates-hit";
const SELECTED_LAYER = "streamsnap-selected-outline";
const LINK_LAYER = "streamsnap-link-line";
const SITE_LAYERS = ["streamsnap-site-halo", "streamsnap-site-dot"];
const SOURCES = [CANDIDATES_SOURCE, SELECTED_SOURCE, LINK_SOURCE, SITE_SOURCE];
const INTERNAL = { "geolibre:internal": true };
const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };
const METRES_PER_DEGREE = 111_000;

export interface SelectedSegmentStyle {
  outlineColor: string;
  outlineWidth: number;
}

export const DEFAULT_SELECTED_STYLE: SelectedSegmentStyle = {
  outlineColor: "#facc15",
  outlineWidth: 2,
};

export interface OverlayView {
  site: Site;
  segments: Segment[];
  candidates: Candidate[];
  selectedIndex: number | null;
  snapped: [number, number] | null;
}

/** Transient review geometry; candidate segments remain visually unchanged. */
export class MatchOverlay {
  private view: OverlayView | null = null;
  private style = DEFAULT_SELECTED_STYLE;

  private readonly restyle = () => {
    if (this.view && !this.map.getLayer(HIT_LAYER)) this.render(this.view);
  };

  private readonly handleClick = (event: MapMouseEvent) => {
    const feature = this.map.queryRenderedFeatures(event.point, {
      layers: [HIT_LAYER],
    })[0];
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

    this.setData(
      CANDIDATES_SOURCE,
      view.candidates.map((candidate) => ({
        type: "Feature",
        geometry: view.segments[candidate.segmentIndex].feature.geometry,
        properties: { segmentIndex: candidate.segmentIndex },
      })),
    );
    this.setData(
      SELECTED_SOURCE,
      view.selectedIndex === null
        ? []
        : [
            {
              type: "Feature",
              geometry: view.segments[view.selectedIndex].feature.geometry,
              properties: {},
            },
          ],
    );

    const link: Feature<LineString>[] = view.snapped
      ? [
          {
            type: "Feature",
            geometry: {
              type: "LineString",
              coordinates: [view.site.lngLat, view.snapped],
            },
            properties: {},
          },
        ]
      : [];
    this.setData(LINK_SOURCE, link);
    this.setData(SITE_SOURCE, [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: view.site.lngLat },
        properties: {},
      },
    ]);
  }

  setSelectedStyle(style: SelectedSegmentStyle): void {
    this.style = style;
    if (!this.map.getLayer(SELECTED_LAYER)) return;
    this.map.setPaintProperty(SELECTED_LAYER, "line-color", style.outlineColor);
    this.map.setPaintProperty(SELECTED_LAYER, "line-width", style.outlineWidth);
  }

  clear(): void {
    this.view = null;
    for (const source of SOURCES) this.setData(source, []);
  }

  destroy(): void {
    this.map.off("styledata", this.restyle);
    this.map.off("click", HIT_LAYER, this.handleClick);
    this.map.off("mouseenter", HIT_LAYER, this.handleEnter);
    this.map.off("mouseleave", HIT_LAYER, this.handleLeave);
    this.map.getCanvas().style.cursor = "";

    for (const layer of [
      HIT_LAYER,
      SELECTED_LAYER,
      LINK_LAYER,
      ...SITE_LAYERS,
    ]) {
      if (this.map.getLayer(layer)) this.map.removeLayer(layer);
    }
    for (const source of SOURCES) {
      if (this.map.getSource(source)) this.map.removeSource(source);
    }
  }

  static radiusBounds(
    [lng, lat]: [number, number],
    radius: number,
  ): [number, number, number, number] {
    const dLat = radius / METRES_PER_DEGREE;
    const dLng = Math.min(
      180,
      radius /
        (METRES_PER_DEGREE *
          Math.max(Math.abs(Math.cos((lat * Math.PI) / 180)), 0.000001)),
    );
    return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
  }

  private setData(sourceId: string, features: Feature[]): void {
    this.map
      .getSource<GeoJSONSource>(sourceId)
      ?.setData({ type: "FeatureCollection", features });
  }

  private ensureLayers(): void {
    for (const id of SOURCES) {
      if (!this.map.getSource(id)) {
        this.map.addSource(id, { type: "geojson", data: EMPTY });
      }
    }

    this.addLayer({
      id: HIT_LAYER,
      type: "line",
      source: CANDIDATES_SOURCE,
      paint: { "line-width": 18, "line-opacity": 0 },
    });
    this.addLayer({
      id: SELECTED_LAYER,
      type: "line",
      source: SELECTED_SOURCE,
      paint: {
        "line-color": this.style.outlineColor,
        "line-width": this.style.outlineWidth,
        "line-gap-width": 2.5,
      },
    });
    this.addLayer({
      id: LINK_LAYER,
      type: "line",
      source: LINK_SOURCE,
      paint: {
        "line-color": "#64748b",
        "line-width": 1.5,
        "line-dasharray": [2, 2],
      },
    });
    this.addLayer({
      id: SITE_LAYERS[0],
      type: "circle",
      source: SITE_SOURCE,
      paint: {
        "circle-radius": 9,
        "circle-color": "#ffffff",
        "circle-opacity": 0.9,
      },
    });
    this.addLayer({
      id: SITE_LAYERS[1],
      type: "circle",
      source: SITE_SOURCE,
      paint: { "circle-radius": 4.5, "circle-color": "#111827" },
    });
  }

  private addLayer(layer: LayerSpecification): void {
    if (!this.map.getLayer(layer.id)) {
      this.map.addLayer({ ...layer, metadata: INTERNAL });
    }
  }
}
