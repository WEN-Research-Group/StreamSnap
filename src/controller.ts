import type { Feature, Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "./host-api";
import {
  DEFAULT_SELECTED_STYLE,
  MatchOverlay,
  type OverlayView,
  type SelectedSegmentStyle,
} from "./overlay";
import {
  SegmentIndex,
  automaticMatch,
  buildSnapped,
  describeAttributes,
  manualMatch,
  prepareSegments,
  prepareSites,
  type AttributeInfo,
  type Candidate,
  type MatchRow,
  type PrimaryKeyValue,
  type Segment,
  type Site,
} from "./matching";
import {
  listWorkspaceVectorLayers,
  onWorkspaceChange,
  readWorkspaceLayer,
  type WorkspaceLayer,
} from "./workspace";

export const DEFAULT_MAX_SEGMENT_DISTANCE_M = 1000;

const FIT_PADDING = 48;
const FIT_MAX_ZOOM = 18;

export type Stage = "settings" | "review";
export type LayerKind = "sites" | "streams";

interface LayerConfig {
  id: string | null;
  attributes: AttributeInfo[];
  visible: Set<string>;
  primaryKey: string | null;
}

export interface Snapshot {
  stage: Stage;
  siteLayers: WorkspaceLayer[];
  streamLayers: WorkspaceLayer[];
  sitesLayerId: string | null;
  streamsLayerId: string | null;
  siteAttributes: AttributeInfo[];
  streamAttributes: AttributeInfo[];
  siteVisibleAttributes: string[];
  streamVisibleAttributes: string[];
  sitePrimaryKey: string | null;
  streamPrimaryKey: string | null;
  maxSegmentDistance: number;
  selectedStyle: SelectedSegmentStyle;
  hasSnappedOutput: boolean;
  message: string;
  rows: Array<MatchRow | null>;
  reviewedCount: number;
  matchedCount: number;
  current: number;
  site: Site | null;
  row: MatchRow | null;
  candidates: Candidate[];
  segments: Segment[];
}

export class StreamSnapController {
  private readonly listeners = new Set<() => void>();
  private readonly overlay: MatchOverlay;
  private readonly stopWatching: () => void;

  private stage: Stage = "settings";
  private layers: WorkspaceLayer[] = [];
  private layerSignature = "";
  private readonly config: Record<LayerKind, LayerConfig> = {
    sites: { id: null, attributes: [], visible: new Set(), primaryKey: null },
    streams: { id: null, attributes: [], visible: new Set(), primaryKey: null },
  };

  private sites: Site[] = [];
  private segments: Segment[] = [];
  private segmentByKey = new Map<PrimaryKeyValue, number>();
  private index: SegmentIndex | null = null;
  private rows: Array<MatchRow | null> = [];
  private candidates: Candidate[] = [];
  private current = 0;
  private streamRevision: string | null = null;

  private maxSegmentDistance = DEFAULT_MAX_SEGMENT_DISTANCE_M;
  private selectedStyle = { ...DEFAULT_SELECTED_STYLE };
  private message = "";

  constructor(
    private readonly app: GeoLibreAppAPI,
    private readonly map: MapLibreMap,
  ) {
    this.overlay = new MatchOverlay(map, (segmentIndex) =>
      this.selectSegment(segmentIndex),
    );
    this.stopWatching = onWorkspaceChange(map, () =>
      this.handleWorkspaceChange(),
    );
    this.refreshLayers();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Snapshot {
    const sites = this.config.sites;
    const streams = this.config.streams;
    return {
      stage: this.stage,
      siteLayers: this.layers.filter((layer) => layer.geometry === "point"),
      streamLayers: this.layers.filter((layer) => layer.geometry === "line"),
      sitesLayerId: sites.id,
      streamsLayerId: streams.id,
      siteAttributes: sites.attributes,
      streamAttributes: streams.attributes,
      siteVisibleAttributes: visibleAttributeNames(sites),
      streamVisibleAttributes: visibleAttributeNames(streams),
      sitePrimaryKey: sites.primaryKey,
      streamPrimaryKey: streams.primaryKey,
      maxSegmentDistance: this.maxSegmentDistance,
      selectedStyle: this.selectedStyle,
      hasSnappedOutput: this.hasSnappedOutput(),
      message: this.message,
      rows: this.rows,
      reviewedCount: this.rows.filter((row) => row !== null).length,
      matchedCount: this.rows.filter(
        (row) => row !== null && row.snapped_stream_key !== null,
      ).length,
      current: this.current,
      site: this.sites[this.current] ?? null,
      row: this.rows[this.current] ?? null,
      candidates: this.candidates,
      segments: this.segments,
    };
  }

  get canStartReviewing(): boolean {
    return Boolean(
      this.stage === "settings" &&
      this.config.sites.id &&
      this.config.streams.id &&
      this.config.sites.primaryKey &&
      this.config.streams.primaryKey,
    );
  }

  get canFinalize(): boolean {
    return Boolean(
      this.stage === "review" &&
      this.rows.length &&
      this.rows.every((row) => row !== null),
    );
  }

  refreshLayers(): void {
    if (this.stage === "review") return;
    const layers = listWorkspaceVectorLayers(this.app);
    const signature = layers
      .map((layer) => `${layer.layerId}:${layer.name}:${layer.geometry}`)
      .join("|");
    if (signature === this.layerSignature) return;

    this.layerSignature = signature;
    this.layers = layers;
    const ids = new Set(layers.map((layer) => layer.layerId));
    for (const kind of ["sites", "streams"] as const) {
      const config = this.config[kind];
      if (config.id && !ids.has(config.id)) this.resetLayerConfiguration(kind);
    }
    this.emit();
  }

  chooseSites(layerId: string): void {
    this.chooseLayer("sites", layerId);
  }

  chooseStreams(layerId: string): void {
    this.chooseLayer("streams", layerId);
  }

  toggleAttribute(kind: LayerKind, name: string): void {
    const config = this.config[kind];
    if (this.stage !== "settings" || config.primaryKey === name) return;
    if (config.visible.has(name)) config.visible.delete(name);
    else config.visible.add(name);
    this.emit();
  }

  choosePrimaryKey(kind: LayerKind, name: string): void {
    if (this.stage !== "settings") return;
    const config = this.config[kind];
    const attribute = config.attributes.find(
      (candidate) => candidate.name === name,
    );
    if (!attribute?.unique) return;

    config.primaryKey = name;
    config.visible.add(name);
    this.emit();
  }

  setMaxSegmentDistance(distance: number): boolean {
    if (this.stage !== "settings" || !(distance > 0)) return false;
    this.maxSegmentDistance = distance;
    this.emit();
    return true;
  }

  startReviewing(): void {
    if (!this.canStartReviewing) return;

    const sitesLayerId = this.config.sites.id!;
    const streamsLayerId = this.config.streams.id!;
    const sitesData = this.read(sitesLayerId);
    const streamsData = this.read(streamsLayerId);
    if (!sitesData || !streamsData) {
      this.message = "The selected layers are no longer available.";
      this.emit();
      return;
    }

    const sites = prepareSites(sitesData);
    if (!sites.length) {
      this.message = "The selected Sites layer has no reviewable features.";
      this.emit();
      return;
    }

    this.sites = sites;
    this.setStreamData(streamsData);
    this.rows = Array.from({ length: sites.length }, () => null);
    this.candidates = [];
    this.current = 0;
    this.stage = "review";
    this.message = "";
    this.matchPreparedCurrent(true);
  }

  goto(index: number): void {
    if (this.stage !== "review" || !this.rows.length) return;
    this.current = Math.min(Math.max(index, 0), this.rows.length - 1);
    if (this.rows[this.current]) {
      this.updateCandidates();
      this.showCurrent(true);
    } else {
      this.matchPreparedCurrent(true);
    }
  }

  previous(): void {
    this.goto(this.current - 1);
  }

  next(): void {
    this.goto(this.current + 1);
  }

  autoMatchCurrent(): void {
    const streamsData = this.config.streams.id
      ? this.read(this.config.streams.id)
      : null;
    this.setStreamData(streamsData);
    this.matchPreparedCurrent();
  }

  private matchPreparedCurrent(fit = false): void {
    const site = this.sites[this.current];
    const streamPrimaryKey = this.config.streams.primaryKey;
    if (!site || !this.index || !streamPrimaryKey) return;
    this.updateCandidates();
    this.rows[this.current] = automaticMatch(
      site,
      this.segments,
      this.candidates[0] ?? null,
      streamPrimaryKey,
    );
    this.message = "";
    this.showCurrent(fit);
  }

  selectSegment(segmentIndex: number): void {
    const site = this.sites[this.current];
    const row = this.rows[this.current];
    const candidate = this.candidates.find(
      (item) => item.segmentIndex === segmentIndex,
    );
    const streamPrimaryKey = this.config.streams.primaryKey;
    if (!site || !row || !candidate || !streamPrimaryKey) return;

    this.rows[this.current] = manualMatch(
      site,
      this.segments,
      candidate,
      row.automatic_stream_key,
      streamPrimaryKey,
    );
    this.showCurrent();
  }

  setSelectedOutlineColor(color: string): void {
    this.selectedStyle = { ...this.selectedStyle, outlineColor: color };
    this.overlay.setSelectedStyle(this.selectedStyle);
    this.emit();
  }

  setSelectedOutlineWidth(width: number): boolean {
    if (!Number.isFinite(width) || width <= 0) return false;
    this.selectedStyle = { ...this.selectedStyle, outlineWidth: width };
    this.overlay.setSelectedStyle(this.selectedStyle);
    this.emit();
    return true;
  }

  finalize(): void {
    if (!this.canFinalize) return;
    const rows = this.rows as MatchRow[];
    const outputName = this.outputName();
    const existingOutputs = this.app
      .listLayers()
      .filter((layer) => layer.name === outputName);
    for (const layer of existingOutputs) {
      this.app.unregisterExternalNativeLayer(layer.id);
    }
    this.app.addGeoJsonLayer(
      outputName,
      buildSnapped(this.sites, rows, this.config.sites.primaryKey!),
    );
    this.message = `${existingOutputs.length ? "Regenerated" : "Added"} “${outputName}” with ${rows.length.toLocaleString()} sites.`;
    this.emit();
  }

  destroy(): void {
    this.stopWatching();
    this.overlay.destroy();
    this.listeners.clear();
  }

  private chooseLayer(kind: LayerKind, layerId: string): void {
    if (this.stage !== "settings") return;
    this.resetLayerConfiguration(kind);
    const config = this.config[kind];
    config.id = layerId || null;
    this.message = "";
    this.emit();
    if (!config.id) return;

    const selectedId = config.id;
    const data = this.read(selectedId);
    if (config.id !== selectedId) return;
    if (!data) {
      this.message = "The selected layer is no longer available.";
      this.emit();
      return;
    }

    const features =
      kind === "sites" ? prepareSites(data) : prepareSegments(data);
    config.attributes = describeAttributes(features);
    this.emit();
  }

  private resetLayerConfiguration(kind: LayerKind): void {
    const config = this.config[kind];
    config.id = null;
    config.attributes = [];
    config.visible.clear();
    config.primaryKey = null;
  }

  private read(layerId: string): Feature<Geometry | null>[] | null {
    const layer = this.layers.find(
      (candidate) => candidate.layerId === layerId,
    );
    return layer ? readWorkspaceLayer(this.app, layer) : null;
  }

  private handleWorkspaceChange(): void {
    if (this.stage === "settings") {
      this.refreshLayers();
      return;
    }

    const site = this.sites[this.current];
    const row = this.rows[this.current];
    const streamId = this.config.streams.id;
    if (!site || !streamId) return;

    const streamsData = this.read(streamId);
    const revision = featureRevision(
      streamsData,
      this.config.streams.primaryKey,
    );
    if (revision === this.streamRevision) return;

    this.setStreamData(streamsData, revision);
    if (row?.manual_revised) {
      this.updateCandidates();
      this.showCurrent();
    } else {
      this.matchPreparedCurrent();
    }
  }

  private showCurrent(fit = false): void {
    const site = this.sites[this.current];
    if (!site || !this.index) {
      this.candidates = [];
      this.overlay.clear();
      this.emit();
      return;
    }

    const row = this.rows[this.current];
    const selectedIndex =
      row?.snapped_stream_key === null || row?.snapped_stream_key === undefined
        ? null
        : (this.segmentByKey.get(row.snapped_stream_key) ?? null);
    const view: OverlayView = {
      site,
      segments: this.segments,
      candidates: this.candidates,
      selectedIndex,
      snapped:
        row?.snap_lng === null || row?.snap_lng === undefined
          ? null
          : [row.snap_lng, row.snap_lat!],
    };
    this.overlay.render(view);
    if (fit) {
      this.map.fitBounds(
        MatchOverlay.radiusBounds(site.lngLat, this.maxSegmentDistance),
        { padding: FIT_PADDING, maxZoom: FIT_MAX_ZOOM, duration: 0 },
      );
    }
    this.emit();
  }

  private setStreamData(
    features: Feature<Geometry | null>[] | null,
    revision = featureRevision(features, this.config.streams.primaryKey),
  ): void {
    this.streamRevision = revision;
    this.segments = prepareSegments(features ?? []);
    this.index = new SegmentIndex(this.segments);
    const primaryKey = this.config.streams.primaryKey;
    this.segmentByKey = new Map();
    if (!primaryKey) return;
    for (const segment of this.segments) {
      const value = segment.properties[primaryKey];
      if (typeof value === "string" || typeof value === "number") {
        this.segmentByKey.set(value, segment.index);
      }
    }
  }

  private updateCandidates(): void {
    const site = this.sites[this.current];
    this.candidates =
      site && this.index
        ? this.index.candidates(site.lngLat, this.maxSegmentDistance)
        : [];
  }

  private outputName(): string {
    const layerName =
      this.layers.find((layer) => layer.layerId === this.config.sites.id)
        ?.name ?? "Sites";
    return `${layerName}_snapped`;
  }

  private hasSnappedOutput(): boolean {
    return this.app
      .listLayers()
      .some((layer) => layer.name === this.outputName());
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

function visibleAttributeNames(config: LayerConfig): string[] {
  return config.attributes
    .map((attribute) => attribute.name)
    .filter((name) => config.visible.has(name));
}

function featureRevision(
  features: Feature<Geometry | null>[] | null,
  primaryKey: string | null,
): string {
  features ??= [];
  const marker = (index: number) => {
    const feature = features[index];
    return feature
      ? String(feature.id ?? feature.properties?.[primaryKey ?? ""] ?? "")
      : "";
  };
  return `${features.length}:${marker(0)}:${marker(features.length - 1)}`;
}
