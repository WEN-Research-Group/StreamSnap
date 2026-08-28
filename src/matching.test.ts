import { describe, expect, it } from "vitest";
import type { Feature, Geometry } from "geojson";
import {
  SegmentIndex,
  autoMatch,
  buildMatchTable,
  buildSnapped,
  manualMatch,
  prepareSegments,
  prepareSites,
  resetMatch,
  type VectorCollection,
} from "./matching";

const site = (lng: number, lat: number, properties: Record<string, unknown> = {}): Feature => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties,
});

const line = (coordinates: number[][]): Feature => ({
  type: "Feature",
  geometry: { type: "LineString", coordinates },
  properties: {},
});

/**
 * Accepts null geometries so the tests can cover them: GeoLibre produces
 * null-geometry features when a delimited text file is loaded as an attribute
 * table, and those must not be matched.
 */
const collection = (features: Feature<Geometry | null>[]): VectorCollection => ({
  type: "FeatureCollection",
  features,
});

/** Two parallel east-west lines: one on the equator, one ~1.1 km north. */
const streams = collection([
  line([
    [0, 0],
    [0.01, 0],
  ]),
  line([
    [0, 0.01],
    [0.01, 0.01],
  ]),
]);

const segments = prepareSegments(streams);
const index = new SegmentIndex(segments);

describe("prepareSites", () => {
  it("skips features that cannot be matched", () => {
    const sites = prepareSites(
      collection([
        site(0, 0),
        { type: "Feature", geometry: null, properties: {} },
        line([
          [0, 0],
          [1, 1],
        ]),
        site(1, 1),
      ]),
    );

    // `index` is the array position; `featureIndex` points back at the layer.
    expect(sites.map((entry) => entry.index)).toEqual([0, 1]);
    expect(sites.map((entry) => entry.featureIndex)).toEqual([0, 3]);
  });
});

describe("SegmentIndex", () => {
  it("returns only segments inside the radius, nearest first", () => {
    // The site sits ~111 m north of the near line and ~1000 m south of the far one.
    const candidates = index.candidates([0.005, 0.001], 500);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].segmentIndex).toBe(0);
    expect(candidates[0].distance).toBeCloseTo(111.2, 0);
  });

  it("includes both segments once the radius covers them", () => {
    const candidates = index.candidates([0.005, 0.001], 1500);
    expect(candidates.map((candidate) => candidate.segmentIndex)).toEqual([0, 1]);
  });

  it("snaps onto the segment rather than to a vertex", () => {
    const [candidate] = index.candidates([0.005, 0.001], 500);
    expect(candidate.snapped[0]).toBeCloseTo(0.005, 6);
    expect(candidate.snapped[1]).toBeCloseTo(0, 6);
    // Distance along the line from its start at longitude 0.
    expect(candidate.along).toBeCloseTo(556, 0);
  });

  it("widens the search past the radius to find the true nearest", () => {
    // Nothing within 500 m, but `nearest` must still resolve the far line.
    expect(index.nearest([0.005, 0.02], 500)?.segmentIndex).toBe(1);
  });
});

describe("autoMatch", () => {
  it("matches every site to its nearest segment", async () => {
    const sites = prepareSites(collection([site(0.005, 0.001), site(0.005, 0.009)]));
    const rows = await autoMatch(sites, segments, index, 500);

    // `stream_index` is the row in the streams layer, for joining back.
    expect(rows.map((row) => row.stream_index)).toEqual([0, 1]);
    expect(rows.every((row) => row.manual === false)).toBe(true);
  });

  it("reports sites with nothing in range as unmatched", async () => {
    const sites = prepareSites(collection([site(50, 50)]));
    const rows = await autoMatch(sites, segments, index, 500);

    expect(rows[0]).toMatchObject({ stream_index: null, dist_m: null, snap_lng: null });
  });
});

describe("manual correction", () => {
  const [subject] = prepareSites(collection([site(0.005, 0.001)]));

  it("flags an overridden match and re-snaps onto the chosen segment", () => {
    const row = manualMatch(subject, segments, 1);
    expect(row.stream_index).toBe(1);
    expect(row.manual).toBe(true);
    expect(row.snap_lat).toBeCloseTo(0.01, 6);
  });

  it("clears the flag when the automatic match is restored", () => {
    const row = resetMatch(subject, segments, index, 500);
    expect(row.stream_index).toBe(0);
    expect(row.manual).toBe(false);
  });
});

describe("outputs", () => {
  const sites = prepareSites(
    collection([site(0.005, 0.001, { river: "Test Creek" }), site(50, 50)]),
  );

  it("builds match_table as one null-geometry row per site", async () => {
    const rows = await autoMatch(sites, segments, index, 500);
    const table = buildMatchTable(rows);

    // Every site gets a row, including the unmatched one.
    expect(table.features).toHaveLength(2);
    expect(table.features.every((feature) => feature.geometry === null)).toBe(true);
    expect(table.features[0].properties).toMatchObject({
      site_index: 0,
      stream_index: 0,
      manual: false,
    });
    expect(table.features[1].properties).toMatchObject({ site_index: 1, stream_index: null });
  });

  it("emits one snapped point per matched site, keeping the site's attributes", async () => {
    const rows = await autoMatch(sites, segments, index, 500);
    const snapped = buildSnapped(sites, rows);

    // The unmatched site is dropped rather than emitted at a bogus location.
    expect(snapped.features).toHaveLength(1);
    expect(snapped.features[0].properties).toMatchObject({
      river: "Test Creek",
      stream_index: 0,
      manual: false,
    });
    expect(snapped.features[0].geometry).toMatchObject({
      type: "Point",
      coordinates: [expect.closeTo(0.005, 6), expect.closeTo(0, 6)],
    });
  });
});
