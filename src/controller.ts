/**
 * StreamSnap's state and behaviour, independent of the DOM.
 *
 * The panel renders from this and calls into it; nothing here touches the panel
 * directly, so the whole review flow stays testable and the UI stays a
 * projection of `snapshot()`.
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { GeoLibreAppAPI } from "./host-api";
import { MatchOverlay, type OverlayView } from "./overlay";
import {
  SegmentIndex,
  autoMatch,
  buildMatchTable,
  buildSnapped,
  manualMatch,
  prepareSegments,
  prepareSites,
  resetMatch,
  type Candidate,
  type MatchRow,
  type Segment,
  type Site,
  type VectorCollection,
} from "./matching";
import {
  listWorkspaceVectorLayers,
  onWorkspaceChange,
  readWorkspaceLayer,
  type WorkspaceLayer,
} from "./workspace";

/**
 * Default search radius. GeoLibre's workspace is always WGS84, so metres are
 * used throughout rather than a degree tolerance, which would shrink east-west
 * with latitude.
 */
export const DEFAULT_RADIUS_M = 500;

/** Padding and zoom cap used when framing a site for review. */
const FIT_PADDING = 80;
const FIT_MAX_ZOOM = 17;

export interface Snapshot {
  siteLayers: WorkspaceLayer[];
  streamLayers: WorkspaceLayer[];
  sitesLayerId: string | null;
  streamsLayerId: string | null;
  radius: number;
  message: string;
  /** Non-empty once the match table exists. */
  rows: MatchRow[];
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

  private layers: WorkspaceLayer[] = [];
  private layerSignature = "";
  private sitesLayerId: string | null = null;
  private streamsLayerId: string | null = null;
  private sitesData: VectorCollection | null = null;
  private streamsData: VectorCollection | null = null;

  private sites: Site[] = [];
  private segments: Segment[] = [];
  /** Source feature index to position in `segments`, for match-row lookups. */
  private segmentByFeatureIndex = new Map<number, number>();
  private index: SegmentIndex | null = null;
  private rows: MatchRow[] = [];
  private candidates: Candidate[] = [];
  private current = 0;

  private radius = DEFAULT_RADIUS_M;
  private message = "";

  constructor(
    private readonly app: GeoLibreAppAPI,
    private readonly map: MapLibreMap,
  ) {
    this.overlay = new MatchOverlay(map, (segmentIndex) => this.selectSegment(segmentIndex));
    this.stopWatching = onWorkspaceChange(map, () => this.refreshLayers());
    this.refreshLayers();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): Snapshot {
    return {
      siteLayers: this.layers.filter((layer) => layer.geometry === "point"),
      streamLayers: this.layers.filter((layer) => layer.geometry === "line"),
      sitesLayerId: this.sitesLayerId,
      streamsLayerId: this.streamsLayerId,
      radius: this.radius,
      message: this.message,
      rows: this.rows,
      current: this.current,
      site: this.sites[this.current] ?? null,
      row: this.rows[this.current] ?? null,
      candidates: this.candidates,
      segments: this.segments,
    };
  }

  /**
   * Re-read the workspace layer list, dropping selections that went away. Cheap
   * to call often: this runs on every `styledata`, so it only notifies when the
   * list really changed rather than re-rendering the panel constantly.
   */
  refreshLayers(): void {
    const layers = listWorkspaceVectorLayers(this.map);
    const signature = layers.map((layer) => `${layer.layerId}:${layer.name}`).join("|");
    if (signature === this.layerSignature) return;

    this.layerSignature = signature;
    this.layers = layers;
    const ids = new Set(layers.map((layer) => layer.layerId));
    if (this.sitesLayerId && !ids.has(this.sitesLayerId)) this.sitesLayerId = null;
    if (this.streamsLayerId && !ids.has(this.streamsLayerId)) this.streamsLayerId = null;
    this.emit();
  }

  async chooseSites(layerId: string): Promise<void> {
    this.sitesLayerId = layerId || null;
    this.sitesData = await this.read(layerId);
    this.clearMatches();
  }

  async chooseStreams(layerId: string): Promise<void> {
    this.streamsLayerId = layerId || null;
    this.streamsData = await this.read(layerId);
    this.clearMatches();
  }

  setRadius(radius: number): void {
    this.radius = radius;
    if (this.rows.length) this.showCurrent();
    this.emit();
  }

  get canMatch(): boolean {
    return Boolean(this.sitesData && this.streamsData);
  }

  /** Build the match table: every site to its nearest segment. */
  async match(): Promise<void> {
    if (!this.sitesData || !this.streamsData) return;

    this.sites = prepareSites(this.sitesData);
    this.setSegments(prepareSegments(this.streamsData));
    this.index = new SegmentIndex(this.segments);

    this.report(`Matching ${this.sites.length.toLocaleString()} sites…`);
    this.rows = await autoMatch(this.sites, this.segments, this.index, this.radius, (done, total) =>
      this.report(`Matching ${done.toLocaleString()} / ${total.toLocaleString()} sites…`),
    );

    this.current = 0;
    this.report(`Matched ${this.rows.length.toLocaleString()} sites.`);
    this.showCurrent();
  }

  goto(index: number): void {
    this.current = Math.min(Math.max(index, 0), this.rows.length - 1);
    this.showCurrent();
  }

  previous(): void {
    this.goto(this.current - 1);
  }

  next(): void {
    this.goto(this.current + 1);
  }

  /** Point the current site at a segment the user picked. */
  selectSegment(segmentIndex: number): void {
    const site = this.sites[this.current];
    if (!site) return;
    this.rows[this.current] = manualMatch(site, this.segments, segmentIndex);
    this.showCurrent();
  }

  /** Restore the current site's automatic match. */
  resetCurrent(): void {
    const site = this.sites[this.current];
    if (!site || !this.index) return;
    this.rows[this.current] = resetMatch(site, this.segments, this.index, this.radius);
    this.showCurrent();
  }

  /** Add the match table to the workspace as a non-spatial attribute table. */
  createMatchTableLayer(): void {
    this.app.addGeoJsonLayer("match_table", buildMatchTable(this.rows));
    this.report(`Added "match_table" with ${this.rows.length.toLocaleString()} rows.`);
  }

  /** Add the snapped points to the workspace as a new layer. */
  createSnappedLayer(): void {
    const snapped = buildSnapped(this.sites, this.rows);
    this.app.addGeoJsonLayer("snapped", snapped);
    this.report(`Added "snapped" with ${snapped.features.length.toLocaleString()} points.`);
  }

  destroy(): void {
    this.stopWatching();
    this.overlay.destroy();
    this.listeners.clear();
  }

  private async read(layerId: string): Promise<VectorCollection | null> {
    const layer = this.layers.find((candidate) => candidate.layerId === layerId);
    return layer ? readWorkspaceLayer(this.map, layer) : null;
  }

  /** Draw the current site, its in-radius candidates, and the chosen segment. */
  private showCurrent(): void {
    const site = this.sites[this.current];
    const row = this.rows[this.current];
    if (!site || !row || !this.index) {
      this.candidates = [];
      this.overlay.clear();
      this.emit();
      return;
    }

    this.candidates = this.index.candidates(site.lngLat, this.radius);

    const view: OverlayView = {
      site,
      segments: this.segments,
      candidates: this.candidates,
      selectedIndex:
        row.stream_index === null
          ? null
          : (this.segmentByFeatureIndex.get(row.stream_index) ?? null),
      snapped: row.snap_lng === null ? null : [row.snap_lng, row.snap_lat!],
    };

    this.overlay.render(view);
    this.map.fitBounds(MatchOverlay.boundsFor(view), {
      padding: FIT_PADDING,
      maxZoom: FIT_MAX_ZOOM,
      duration: 300,
    });
    this.emit();
  }

  private setSegments(segments: Segment[]): void {
    this.segments = segments;
    this.segmentByFeatureIndex = new Map(
      segments.map((segment) => [segment.featureIndex, segment.index]),
    );
  }

  private clearMatches(): void {
    this.sites = [];
    this.setSegments([]);
    this.rows = [];
    this.candidates = [];
    this.index = null;
    this.current = 0;
    this.overlay.clear();
    this.emit();
  }

  private report(message: string): void {
    this.message = message;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
