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
import RBush from "rbush";

const METRES_PER_DEGREE = 111_000;

export interface Site {
  index: number;
  featureIndex: number;
  featureId: string | number | null;
  lngLat: [number, number];
  properties: Record<string, unknown>;
}

export interface Segment {
  index: number;
  featureIndex: number;
  properties: Record<string, unknown>;
  feature: Feature<LineString | MultiLineString>;
}

export interface AttributeInfo {
  name: string;
  unique: boolean;
}

export interface Candidate {
  segmentIndex: number;
  distance: number;
  snapped: [number, number];
}

export type PrimaryKeyValue = string | number;

export interface MatchRow {
  site_index: number;
  automatic_stream_key: PrimaryKeyValue | null;
  snapped_stream_index: number | null;
  snapped_stream_key: PrimaryKeyValue | null;
  snap_distance_m: number | null;
  snap_lng: number | null;
  snap_lat: number | null;
  manual_revised: boolean;
}

interface IndexEntry {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  segmentIndex: number;
}

export function prepareSites(
  features: ReadonlyArray<Feature<Geometry | null>>,
): Site[] {
  const sites: Site[] = [];
  features.forEach((feature, featureIndex) => {
    if (feature.geometry?.type !== "Point") return;
    const [lng, lat] = feature.geometry.coordinates;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return;

    sites.push({
      index: sites.length,
      featureIndex,
      featureId: feature.id ?? null,
      lngLat: [lng, lat],
      properties: feature.properties ?? {},
    });
  });
  return sites;
}

export function prepareSegments(
  features: ReadonlyArray<Feature<Geometry | null>>,
): Segment[] {
  const segments: Segment[] = [];
  features.forEach((feature, featureIndex) => {
    const type = feature.geometry?.type;
    if (type !== "LineString" && type !== "MultiLineString") return;

    segments.push({
      index: segments.length,
      featureIndex,
      properties: feature.properties ?? {},
      feature: feature as Feature<LineString | MultiLineString>,
    });
  });
  return segments;
}

/** Attribute names plus whether every feature has a distinct string or integer value. */
export function describeAttributes(
  features: ReadonlyArray<{ properties: Record<string, unknown> }>,
): AttributeInfo[] {
  const names = new Set(
    features.flatMap((feature) => Object.keys(feature.properties)),
  );
  return [...names].map((name) => ({
    name,
    unique: hasUniqueValues(features, name),
  }));
}

export class SegmentIndex {
  private readonly tree = new RBush<IndexEntry>();

  constructor(private readonly segments: Segment[]) {
    this.tree.load(segments.map(toIndexEntry));
  }

  /** Segments within the radius, measured exactly and returned nearest first. */
  candidates(lngLat: [number, number], radius: number): Candidate[] {
    const [lng, lat] = lngLat;
    const dLat = radius / METRES_PER_DEGREE;
    const latitudeScale = Math.abs(Math.cos((lat * Math.PI) / 180));
    const dLng = Math.min(
      180,
      radius / (METRES_PER_DEGREE * Math.max(latitudeScale, 0.000001)),
    );

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
}

/** Match only the site currently being reviewed. */
export function automaticMatch(
  site: Site,
  segments: Segment[],
  candidate: Candidate | null,
  streamPrimaryKey: string,
): MatchRow {
  const automaticStreamKey = candidate
    ? primaryKeyValue(
        segments[candidate.segmentIndex].properties[streamPrimaryKey],
      )
    : null;
  return buildRow(
    site,
    segments,
    candidate,
    automaticStreamKey,
    automaticStreamKey,
  );
}

/** Select a candidate while comparing it with the retained automatic result. */
export function manualMatch(
  site: Site,
  segments: Segment[],
  candidate: Candidate,
  automaticStreamKey: PrimaryKeyValue | null,
  streamPrimaryKey: string,
): MatchRow {
  const snappedStreamKey = primaryKeyValue(
    segments[candidate.segmentIndex].properties[streamPrimaryKey],
  );
  return buildRow(
    site,
    segments,
    candidate,
    automaticStreamKey,
    snappedStreamKey,
  );
}

/** Build the single finalized point layer, preserving source-site row order. */
export function buildSnapped(
  sites: Site[],
  rows: MatchRow[],
  sitePrimaryKey: string,
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: sites.map((site) => {
      const row = rows[site.index];
      const coordinates: [number, number] =
        row.snap_lng === null ? site.lngLat : [row.snap_lng, row.snap_lat!];

      return {
        type: "Feature",
        id: site.featureId ?? site.featureIndex,
        geometry: { type: "Point", coordinates },
        properties: {
          site_primary_key: site.properties[sitePrimaryKey] ?? null,
          stream_primary_key: row.snapped_stream_key,
          snapped_stream_index: row.snapped_stream_index,
          snap_distance_m: row.snap_distance_m,
          manual_revised: row.manual_revised,
        },
      };
    }),
  };
}

function buildRow(
  site: Site,
  segments: Segment[],
  candidate: Candidate | null,
  automaticStreamKey: PrimaryKeyValue | null,
  snappedStreamKey: PrimaryKeyValue | null,
): MatchRow {
  if (!candidate) {
    return {
      site_index: site.featureIndex,
      automatic_stream_key: automaticStreamKey,
      snapped_stream_index: null,
      snapped_stream_key: null,
      snap_distance_m: null,
      snap_lng: null,
      snap_lat: null,
      manual_revised: false,
    };
  }

  return {
    site_index: site.featureIndex,
    automatic_stream_key: automaticStreamKey,
    snapped_stream_index: segments[candidate.segmentIndex].featureIndex,
    snapped_stream_key: snappedStreamKey,
    snap_distance_m: Math.round(candidate.distance * 100) / 100,
    snap_lng: candidate.snapped[0],
    snap_lat: candidate.snapped[1],
    manual_revised: snappedStreamKey !== automaticStreamKey,
  };
}

function primaryKeyValue(value: unknown): PrimaryKeyValue | null {
  return typeof value === "string" || typeof value === "number" ? value : null;
}

function measure(segment: Segment, lngLat: [number, number]): Candidate {
  const snapped = nearestPointOnLine(segment.feature, lngLat, {
    units: "meters",
  });
  const [lng, lat] = snapped.geometry.coordinates;
  return {
    segmentIndex: segment.index,
    distance: snapped.properties.pointDistance,
    snapped: [lng, lat],
  };
}

function toIndexEntry(segment: Segment): IndexEntry {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  const geometry = segment.feature.geometry;
  const parts: Position[][] =
    geometry.type === "LineString"
      ? [geometry.coordinates]
      : geometry.coordinates;

  for (const part of parts) {
    for (const [lng, lat] of part) {
      minX = Math.min(minX, lng);
      minY = Math.min(minY, lat);
      maxX = Math.max(maxX, lng);
      maxY = Math.max(maxY, lat);
    }
  }
  return { minX, minY, maxX, maxY, segmentIndex: segment.index };
}

function hasUniqueValues(
  features: ReadonlyArray<{ properties: Record<string, unknown> }>,
  name: string,
): boolean {
  if (!features.length) return false;
  const values = new Set<string>();
  for (const feature of features) {
    const value = feature.properties[name];
    if (
      (typeof value !== "string" &&
        (typeof value !== "number" || !Number.isInteger(value))) ||
      value === ""
    ) {
      return false;
    }
    const key = `${typeof value}:${value}`;
    if (values.has(key)) return false;
    values.add(key);
  }
  return true;
}
