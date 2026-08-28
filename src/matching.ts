/**
 * Site-to-segment matching and snapping.
 *
 * GeoLibre renders through MapLibre, so every workspace layer is WGS84 lon/lat.
 * Distances are therefore geodesic metres computed by Turf rather than degrees,
 * which keeps a radius meaningful at any latitude. The R-tree holds degree
 * bounding boxes only, as a conservative prefilter: a segment whose true
 * distance to a point is at most `r` always has a bounding box within `r` of
 * it, so widening the box by `r` never drops a real candidate.
 *
 * Two kinds of index appear here and must not be confused. `index` is a
 * position in the prepared `sites`/`segments` arrays and is the handle the UI
 * passes around; `featureIndex` is the row's position in the source layer, and
 * is what the match table records so its rows join back to the layers.
 */
import RBush from "rbush";
import { nearestPointOnLine } from "@turf/nearest-point-on-line";
import type {
  Feature,
  FeatureCollection,
  Geometry,
  LineString,
  MultiLineString,
  Point,
  Position,
} from "geojson";

/**
 * A workspace layer's features. Geometry is nullable because GeoLibre loads a
 * delimited text file as an attribute table of null-geometry features.
 */
export type VectorCollection = FeatureCollection<Geometry | null>;

/** Metres per degree of latitude. */
const METRES_PER_DEGREE = 111_320;

/**
 * How far the automatic pass may widen its search before giving a site up.
 * Reached only by sites far off the network; the search doubles from the user's
 * radius, so a 500 m start gives up past ~256 km.
 */
const MAX_SEARCH_RADIUS_M = 256_000;

/** Sites processed between yields, so a large layer does not freeze the panel. */
const AUTO_MATCH_CHUNK = 250;

export type LineFeature = Feature<LineString | MultiLineString>;

export interface Site {
  /** Position in the prepared sites array; what Previous/Next steps through. */
  index: number;
  /** Position in the source sites layer. */
  featureIndex: number;
  lngLat: [number, number];
  properties: Record<string, unknown>;
}

export interface Segment {
  /** Position in the prepared segments array; the handle used for selection. */
  index: number;
  /** Position in the source streams layer. */
  featureIndex: number;
  feature: LineFeature;
}

export interface Candidate {
  segmentIndex: number;
  /** Distance from the site to the segment, in metres. */
  distance: number;
  /** The point on the segment closest to the site. */
  snapped: [number, number];
  /** Distance from the segment's start to the snapped point, in metres. */
  along: number;
}

/** One row of `match_table`. Null throughout when no segment was in range. */
export interface MatchRow {
  site_index: number;
  stream_index: number | null;
  dist_m: number | null;
  along_m: number | null;
  snap_lng: number | null;
  snap_lat: number | null;
  /** False for an automatic match, true once the user changes the selection. */
  manual: boolean;
}

interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  segmentIndex: number;
}

/**
 * Flatten a point collection into sites. Multi-point and null-geometry features
 * are skipped: a monitoring site is a single location, and an attribute-table
 * row has nothing to match.
 */
export function prepareSites(collection: VectorCollection): Site[] {
  const sites: Site[] = [];
  collection.features.forEach((feature, featureIndex) => {
    if (feature.geometry?.type !== "Point") return;
    const [lng, lat] = (feature.geometry as Point).coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

    sites.push({
      index: sites.length,
      featureIndex,
      lngLat: [lng, lat],
      properties: (feature.properties ?? {}) as Record<string, unknown>,
    });
  });
  return sites;
}

/** Flatten a line collection into matchable segments, one per feature. */
export function prepareSegments(collection: VectorCollection): Segment[] {
  const segments: Segment[] = [];
  collection.features.forEach((feature, featureIndex) => {
    const type = feature.geometry?.type;
    if (type !== "LineString" && type !== "MultiLineString") return;

    segments.push({
      index: segments.length,
      featureIndex,
      feature: feature as LineFeature,
    });
  });
  return segments;
}

/** Spatial index over stream segments, supporting radius and nearest queries. */
export class SegmentIndex {
  private readonly tree = new RBush<IndexEntry>();

  constructor(private readonly segments: Segment[]) {
    this.tree.load(segments.map(toIndexEntry));
  }

  /**
   * Every segment within `radius` metres of `lngLat`, nearest first. Exact: the
   * bounding-box prefilter only over-selects, and each survivor is measured
   * against the real geometry.
   */
  candidates(lngLat: [number, number], radius: number): Candidate[] {
    const [lng, lat] = lngLat;
    const dLat = radius / METRES_PER_DEGREE;
    // Degrees of longitude shrink toward the poles; clamp so a near-polar site
    // widens the box instead of dividing by ~0.
    const dLng = radius / (METRES_PER_DEGREE * Math.max(Math.cos((lat * Math.PI) / 180), 0.01));

    const found: Candidate[] = [];
    for (const entry of this.tree.search({
      minX: lng - dLng,
      minY: lat - dLat,
      maxX: lng + dLng,
      maxY: lat + dLat,
    })) {
      const candidate = measure(this.segments[entry.segmentIndex], lngLat);
      if (candidate.distance <= radius) found.push(candidate);
    }
    return found.sort((a, b) => a.distance - b.distance);
  }

  /**
   * The single nearest segment, searching from `radius` and doubling until
   * something is found. Exact for the same reason `candidates` is: if any
   * segment lies within `r`, the closest of those beats everything outside `r`,
   * so the first non-empty ring holds the global nearest.
   */
  nearest(lngLat: [number, number], radius: number): Candidate | null {
    for (let search = radius; search <= MAX_SEARCH_RADIUS_M; search *= 2) {
      const [best] = this.candidates(lngLat, search);
      if (best) return best;
    }
    return null;
  }
}

/**
 * Match every site to its nearest segment. Yields between chunks so the panel
 * stays responsive and can report progress.
 */
export async function autoMatch(
  sites: Site[],
  segments: Segment[],
  index: SegmentIndex,
  radius: number,
  onProgress?: (done: number, total: number) => void,
): Promise<MatchRow[]> {
  const rows: MatchRow[] = [];
  for (const site of sites) {
    rows.push(buildRow(site, segments, index.nearest(site.lngLat, radius), false));
    if (rows.length % AUTO_MATCH_CHUNK === 0) {
      onProgress?.(rows.length, sites.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  onProgress?.(rows.length, sites.length);
  return rows;
}

/** Re-point one site at a segment the user picked, flagging the row as manual. */
export function manualMatch(site: Site, segments: Segment[], segmentIndex: number): MatchRow {
  return buildRow(site, segments, measure(segments[segmentIndex], site.lngLat), true);
}

/** Recompute one site's automatic match, clearing its manual flag. */
export function resetMatch(
  site: Site,
  segments: Segment[],
  index: SegmentIndex,
  radius: number,
): MatchRow {
  return buildRow(site, segments, index.nearest(site.lngLat, radius), false);
}

/**
 * `match_table` as a GeoLibre layer: one null-geometry feature per row, which
 * is how GeoLibre represents a non-spatial attribute table.
 */
export function buildMatchTable(rows: MatchRow[]): FeatureCollection<null> {
  return {
    type: "FeatureCollection",
    features: rows.map((row) => ({ type: "Feature", geometry: null, properties: { ...row } })),
  };
}

/**
 * The `snapped` output: one point per matched site, placed on its segment and
 * carrying the site's own attributes alongside the match columns.
 */
export function buildSnapped(sites: Site[], rows: MatchRow[]): FeatureCollection {
  const features: Feature[] = [];

  for (const site of sites) {
    const row = rows[site.index];
    if (!row || row.stream_index === null) continue;
    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [row.snap_lng!, row.snap_lat!] },
      properties: {
        ...site.properties,
        site_index: row.site_index,
        stream_index: row.stream_index,
        dist_m: row.dist_m,
        along_m: row.along_m,
        manual: row.manual,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

function buildRow(
  site: Site,
  segments: Segment[],
  candidate: Candidate | null,
  manual: boolean,
): MatchRow {
  if (!candidate) {
    return {
      site_index: site.featureIndex,
      stream_index: null,
      dist_m: null,
      along_m: null,
      snap_lng: null,
      snap_lat: null,
      manual,
    };
  }

  return {
    site_index: site.featureIndex,
    stream_index: segments[candidate.segmentIndex].featureIndex,
    dist_m: round(candidate.distance),
    along_m: round(candidate.along),
    snap_lng: candidate.snapped[0],
    snap_lat: candidate.snapped[1],
    manual,
  };
}

/** Exact distance from a point to a segment, plus where on it the point lands. */
function measure(segment: Segment, lngLat: [number, number]): Candidate {
  const snapped = nearestPointOnLine(segment.feature, lngLat, { units: "meters" });
  const [lng, lat] = snapped.geometry.coordinates;
  return {
    segmentIndex: segment.index,
    distance: snapped.properties.pointDistance,
    snapped: [lng, lat],
    along: snapped.properties.totalDistance,
  };
}

function toIndexEntry(segment: Segment): IndexEntry {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const geometry = segment.feature.geometry;
  const parts: Position[][] =
    geometry.type === "LineString" ? [geometry.coordinates] : geometry.coordinates;
  for (const part of parts) {
    for (const [lng, lat] of part) {
      if (lng < minX) minX = lng;
      if (lng > maxX) maxX = lng;
      if (lat < minY) minY = lat;
      if (lat > maxY) maxY = lat;
    }
  }

  return { minX, minY, maxX, maxY, segmentIndex: segment.index };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
