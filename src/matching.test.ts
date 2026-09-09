import { describe, expect, it } from "vitest";
import type { Feature, Geometry } from "geojson";
import {
  SegmentIndex,
  automaticMatch,
  buildSnapped,
  describeAttributes,
  manualMatch,
  prepareSegments,
  prepareSites,
} from "./matching";

const site = (
  lng: number,
  lat: number,
  properties: Record<string, unknown> = {},
  id?: string | number,
): Feature => ({
  type: "Feature",
  id,
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties,
});

const line = (
  coordinates: number[][],
  properties: Record<string, unknown> = {},
): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties,
});

const streams: Feature<Geometry | null>[] = [
  line(
    [
      [0, 0],
      [0.01, 0],
    ],
    { stream_id: "near" },
  ),
  line(
    [
      [0, 0.01],
      [0.01, 0.01],
    ],
    { stream_id: "far" },
  ),
];

const segments = prepareSegments(streams);
const index = new SegmentIndex(segments);

describe("feature preparation", () => {
  it("keeps source indexes while skipping non-point site rows", () => {
    const sites = prepareSites([
      site(0, 0, { site_id: "a" }, "site-a"),
      { type: "Feature", geometry: null, properties: {} },
      line([
        [0, 0],
        [1, 1],
      ]),
      site(1, 1, { site_id: "b" }),
    ]);

    expect(sites.map((entry) => entry.index)).toEqual([0, 1]);
    expect(sites.map((entry) => entry.featureIndex)).toEqual([0, 3]);
    expect(sites.map((entry) => entry.featureId)).toEqual(["site-a", null]);
  });

  it("marks only complete, distinct string or integer attributes as unique", () => {
    const sites = prepareSites([
      site(0, 0, { id: 1, repeated: "x", decimal: 1.5 }),
      site(1, 1, { id: 2, repeated: "x", decimal: 2.5 }),
    ]);
    expect(describeAttributes(sites)).toEqual([
      { name: "id", unique: true },
      { name: "repeated", unique: false },
      { name: "decimal", unique: false },
    ]);
  });

  it("keeps attributes in their source order", () => {
    const sites = prepareSites([
      site(0, 0, { zeta: 1, alpha: "a" }),
      site(1, 1, { zeta: 2, alpha: "b", middle: true }),
    ]);

    expect(describeAttributes(sites).map(({ name }) => name)).toEqual([
      "zeta",
      "alpha",
      "middle",
    ]);
  });
});

describe("SegmentIndex", () => {
  it("filters by radius, sorts by distance, and snaps onto the line", () => {
    const candidates = index.candidates([0.005, 0.001], 500);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].segmentIndex).toBe(0);
    expect(candidates[0].distance).toBeCloseTo(111.2, 0);
    expect(candidates[0].snapped).toEqual([
      expect.closeTo(0.005, 6),
      expect.closeTo(0, 6),
    ]);
    expect(
      index
        .candidates([0.005, 0.001], 1500)
        .map((candidate) => candidate.segmentIndex),
    ).toEqual([0, 1]);
  });
});

describe("per-site review", () => {
  const [subject] = prepareSites([site(0.005, 0.001, { site_id: "station" })]);
  const candidates = index.candidates(subject.lngLat, 1500);

  it("flags a manual result only while it differs from the automatic one", () => {
    const automatic = automaticMatch(
      subject,
      segments,
      candidates[0],
      "stream_id",
    );
    expect(automatic).toMatchObject({
      automatic_stream_key: "near",
      snapped_stream_index: 0,
      snapped_stream_key: "near",
      manual_revised: false,
    });
    expect(
      manualMatch(
        subject,
        segments,
        candidates[1],
        automatic.automatic_stream_key,
        "stream_id",
      ),
    ).toMatchObject({ snapped_stream_key: "far", manual_revised: true });
    expect(
      manualMatch(
        subject,
        segments,
        candidates[0],
        automatic.automatic_stream_key,
        "stream_id",
      ),
    ).toMatchObject({ snapped_stream_key: "near", manual_revised: false });
  });
});

describe("finalized output", () => {
  it("keeps site order and unmatched sites in one snapped point layer", () => {
    const sites = prepareSites([
      site(0.005, 0.001, { site_id: "a", note: "matched" }, "a"),
      site(50, 50, { site_id: "b", note: "unmatched" }, "b"),
    ]);
    const rows = sites.map((entry) =>
      automaticMatch(
        entry,
        segments,
        index.candidates(entry.lngLat, 500)[0] ?? null,
        "stream_id",
      ),
    );
    const snapped = buildSnapped(sites, rows, "site_id");

    expect(snapped.features).toHaveLength(2);
    expect(snapped.features.map((feature) => feature.id)).toEqual(["a", "b"]);
    expect(snapped.features[0].properties).toEqual({
      site_primary_key: "a",
      stream_primary_key: "near",
      snapped_stream_index: 0,
      snap_distance_m: expect.any(Number),
      manual_revised: false,
    });
    expect(snapped.features[0].geometry.coordinates).toEqual([
      expect.closeTo(0.005, 6),
      expect.closeTo(0, 6),
    ]);
    expect(snapped.features[1].properties).toEqual({
      site_primary_key: "b",
      stream_primary_key: null,
      snapped_stream_index: null,
      snap_distance_m: null,
      manual_revised: false,
    });
    expect(snapped.features[1].geometry.coordinates).toEqual([50, 50]);
  });
});
