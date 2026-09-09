import { describe, expect, it } from "vitest";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import type { Map as MapLibreMap } from "maplibre-gl";
import { StreamSnapController } from "./controller";
import type { GeoLibreAppAPI } from "./host-api";

type TestMap = MapLibreMap & { fire: (event: string) => void };

const sites: Feature[] = [
  {
    type: "Feature",
    id: "site-1",
    geometry: { type: "Point", coordinates: [0.005, 0.001] },
    properties: { site_id: "one", label: "Site one" },
  },
  {
    type: "Feature",
    id: "site-2",
    geometry: { type: "Point", coordinates: [0.005, 0.009] },
    properties: { site_id: "two", label: "Site two" },
  },
];

const streams: Feature[] = [
  {
    type: "Feature",
    id: "stream-a",
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0],
        [0.01, 0],
      ],
    },
    properties: { stream_id: "a", name: "Near" },
  },
  {
    type: "Feature",
    id: "stream-b",
    geometry: {
      type: "LineString",
      coordinates: [
        [0, 0.01],
        [0.01, 0.01],
      ],
    },
    properties: { stream_id: "b", name: "Far" },
  },
];

function createApp(
  outputs: Array<{ name: string; data: FeatureCollection }> = [],
  getFeatures: (id: string) => Feature<Geometry | null>[] = (id) =>
    id === "sites" ? sites : streams,
): GeoLibreAppAPI {
  const outputIds = new Map<string, (typeof outputs)[number]>();
  let nextOutputId = 1;
  return {
    addGeoJsonLayer: (name, output) => {
      const id = `output-${nextOutputId++}`;
      const record = { name, data: output as FeatureCollection };
      outputs.push(record);
      outputIds.set(id, record);
      return id;
    },
    unregisterExternalNativeLayer: (id) => {
      const output = outputIds.get(id);
      if (!output) return;
      outputs.splice(outputs.indexOf(output), 1);
      outputIds.delete(id);
    },
    listLayers: () => [
      {
        id: "sites",
        name: "sites",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
      {
        id: "streams",
        name: "streams",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
      ...Array.from(outputIds, ([id, output]) => ({
        id,
        name: output.name,
        type: "geojson",
        visible: true,
        opacity: 1,
      })),
    ],
    getLayerFeatures: (id) =>
      outputIds.get(id)?.data.features ?? getFeatures(id),
    getMap: () => createMap(),
    registerRightPanel: () => () => undefined,
    openRightPanel: () => true,
    closeRightPanel: () => undefined,
  };
}

function createMap(): TestMap {
  const source = () => ({ setData: () => undefined });
  const sources = new Map([
    ["source-sites", source()],
    ["source-streams", source()],
  ]);
  const layers = new Set<string>();
  const listeners = new Map<string, Set<() => void>>();
  const map = {
    on: (event: string, ...args: unknown[]) => {
      const listener = args.at(-1);
      if (typeof listener === "function") {
        const callbacks = listeners.get(event) ?? new Set();
        callbacks.add(listener as () => void);
        listeners.set(event, callbacks);
      }
      return map;
    },
    off: (event: string, ...args: unknown[]) => {
      const listener = args.at(-1);
      if (typeof listener === "function") {
        listeners.get(event)?.delete(listener as () => void);
      }
      return map;
    },
    fire: (event: string) => {
      for (const listener of listeners.get(event) ?? []) listener();
    },
    getSource: (id: string) => sources.get(id),
    addSource: (id: string) => {
      sources.set(id, source());
    },
    removeSource: (id: string) => sources.delete(id),
    getLayer: (id: string) => (layers.has(id) ? { id } : undefined),
    addLayer: (layer: { id: string }) => layers.add(layer.id),
    removeLayer: (id: string) => layers.delete(id),
    setPaintProperty: () => map,
    fitBounds: () => map,
    queryRenderedFeatures: () => [],
    getCanvas: () => ({ style: { cursor: "" } }),
  };
  return map as unknown as TestMap;
}

function start(controller: StreamSnapController): void {
  controller.chooseSites("sites");
  controller.chooseStreams("streams");
  controller.choosePrimaryKey("sites", "site_id");
  controller.choosePrimaryKey("streams", "stream_id");
  controller.startReviewing();
}

describe("StreamSnapController", () => {
  it("keeps attributes hidden until selected and forces primary keys visible", () => {
    const controller = new StreamSnapController(createApp(), createMap());
    controller.chooseSites("sites");

    expect(controller.snapshot().siteVisibleAttributes).toEqual([]);
    controller.toggleAttribute("sites", "label");
    expect(controller.snapshot().siteVisibleAttributes).toEqual(["label"]);
    controller.choosePrimaryKey("sites", "site_id");
    expect(controller.snapshot().siteVisibleAttributes).toEqual([
      "site_id",
      "label",
    ]);
    controller.toggleAttribute("sites", "site_id");
    expect(controller.snapshot().siteVisibleAttributes).toContain("site_id");
    controller.destroy();
  });

  it("matches on first review and marks only a real override as manual", () => {
    const controller = new StreamSnapController(createApp(), createMap());
    controller.setMaxSegmentDistance(1500);
    start(controller);

    expect(controller.snapshot().row).toMatchObject({
      snapped_stream_index: 0,
      automatic_stream_key: "a",
      snapped_stream_key: "a",
      manual_revised: false,
    });
    expect(controller.snapshot().matchedCount).toBe(1);
    controller.selectSegment(1);
    expect(controller.snapshot().row).toMatchObject({
      snapped_stream_index: 1,
      snapped_stream_key: "b",
      manual_revised: true,
    });
    controller.autoMatchCurrent();
    expect(controller.snapshot().row).toMatchObject({
      snapped_stream_index: 0,
      manual_revised: false,
    });
    controller.destroy();
  });

  it("retries the current automatic match when visible streams change", () => {
    let currentStreams = [streams[1]];
    const getFeatures = (id: string) =>
      id === "sites" ? sites : currentStreams;
    const map = createMap();
    const controller = new StreamSnapController(
      createApp([], getFeatures),
      map,
    );
    controller.setMaxSegmentDistance(1500);
    start(controller);
    expect(controller.snapshot().row?.snap_lat).toBeCloseTo(0.01);

    currentStreams = streams;
    map.fire("idle");
    expect(controller.snapshot().row?.snap_lat).toBeCloseTo(0);
    controller.destroy();
  });

  it("leaves a site unmatched when no stream data is currently available", () => {
    let currentStreams = streams;
    const getFeatures = (id: string) =>
      id === "sites" ? sites : currentStreams;
    const controller = new StreamSnapController(
      createApp([], getFeatures),
      createMap(),
    );
    start(controller);

    currentStreams = [];
    controller.autoMatchCurrent();

    expect(controller.snapshot()).toMatchObject({
      message: "",
      matchedCount: 0,
      row: {
        snapped_stream_index: null,
        snap_distance_m: null,
      },
    });
    controller.destroy();
  });

  it("keeps stream keys stable when viewport snapshots reuse feature indexes", () => {
    const outputs: Array<{ name: string; data: FeatureCollection }> = [];
    let currentStreams = [streams[0]];
    const map = createMap();
    const controller = new StreamSnapController(
      createApp(outputs, (id) => (id === "sites" ? sites : currentStreams)),
      map,
    );
    controller.setMaxSegmentDistance(1500);
    start(controller);

    controller.next();
    currentStreams = [streams[1]];
    map.fire("idle");
    controller.finalize();

    expect(
      outputs[0].data.features.map(
        (feature) => feature.properties?.stream_primary_key,
      ),
    ).toEqual(["a", "b"]);
    expect(
      outputs[0].data.features.map(
        (feature) => feature.properties?.snapped_stream_index,
      ),
    ).toEqual([0, 0]);
    controller.destroy();
  });

  it("refreshes viewport candidates without replacing a manual match", () => {
    let currentStreams = streams;
    const map = createMap();
    const controller = new StreamSnapController(
      createApp([], (id) => (id === "sites" ? sites : currentStreams)),
      map,
    );
    controller.setMaxSegmentDistance(1500);
    start(controller);
    controller.selectSegment(1);

    currentStreams = [streams[0]];
    map.fire("idle");

    expect(controller.snapshot()).toMatchObject({
      row: {
        snapped_stream_key: "b",
        manual_revised: true,
      },
      segments: [{ properties: { stream_id: "a" } }],
      candidates: [{ segmentIndex: 0 }],
    });
    controller.destroy();
  });

  it("regenerates the snapped layer from an editable review", () => {
    const outputs: Array<{ name: string; data: FeatureCollection }> = [];
    const controller = new StreamSnapController(
      createApp(outputs),
      createMap(),
    );
    controller.setMaxSegmentDistance(1500);
    start(controller);
    controller.next();
    controller.finalize();

    expect(outputs).toHaveLength(1);
    expect(outputs[0].name).toBe("sites_snapped");
    expect(outputs[0].data.features).toHaveLength(sites.length);
    expect(controller.snapshot().hasSnappedOutput).toBe(true);
    expect(controller.canFinalize).toBe(true);

    controller.goto(0);
    controller.autoMatchCurrent();
    expect(controller.snapshot().row).toMatchObject({
      snapped_stream_index: 0,
      manual_revised: false,
    });
    expect(controller.snapshot().hasSnappedOutput).toBe(true);

    controller.selectSegment(1);
    expect(controller.snapshot().row).toMatchObject({
      snapped_stream_index: 1,
      manual_revised: true,
    });
    controller.finalize();

    expect(outputs).toHaveLength(1);
    expect(outputs[0].data.features[0].properties).toMatchObject({
      snapped_stream_index: 1,
      manual_revised: true,
    });
    const geometry = outputs[0].data.features[0].geometry;
    expect(geometry?.type).toBe("Point");
    if (geometry?.type !== "Point") throw new Error("Expected point output");
    expect(geometry.coordinates[0]).toBeCloseTo(0.005);
    expect(geometry.coordinates[1]).toBeCloseTo(0.01);
    expect(controller.snapshot().message).toContain("Regenerated");
    controller.destroy();
  });
});
