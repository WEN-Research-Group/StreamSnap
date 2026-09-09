import { describe, expect, it, vi } from "vitest";
import type { Feature, Geometry } from "geojson";
import type { GeoLibreAppAPI } from "./host-api";
import { listWorkspaceVectorLayers, readWorkspaceLayer } from "./workspace";

const point: Feature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [0, 0] },
  properties: {},
};

const line: Feature = {
  type: "Feature",
  geometry: {
    type: "LineString",
    coordinates: [
      [0, 0],
      [1, 1],
    ],
  },
  properties: {},
};

const polygon: Feature = {
  type: "Feature",
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [0, 0],
      ],
    ],
  },
  properties: {},
};

function createApp(
  getFeatures: (id: string) => Feature<Geometry | null>[],
): GeoLibreAppAPI {
  return {
    listLayers: () => [
      {
        id: "streams",
        name: "Streams",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
      {
        id: "areas",
        name: "Areas",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
      {
        id: "sites",
        name: "Sites",
        type: "geojson",
        visible: true,
        opacity: 1,
      },
    ],
    getLayerFeatures: getFeatures,
  } as GeoLibreAppAPI;
}

describe("GeoLibre workspace", () => {
  it("lists point and line layers from the GeoLibre layer API", () => {
    const getFeatures = vi.fn((id: string) => {
      if (id === "sites") return [point];
      if (id === "streams") return [line];
      return [polygon];
    });

    expect(listWorkspaceVectorLayers(createApp(getFeatures))).toEqual([
      { layerId: "sites", name: "Sites", geometry: "point" },
      { layerId: "streams", name: "Streams", geometry: "line" },
    ]);
    expect(getFeatures).toHaveBeenCalledTimes(3);
  });

  it("reads features directly from the GeoLibre layer API", () => {
    const getFeatures = vi.fn(() => [line]);
    const layer = {
      layerId: "streams",
      name: "Streams",
      geometry: "line" as const,
    };

    expect(readWorkspaceLayer(createApp(getFeatures), layer)).toEqual([line]);
    expect(getFeatures).toHaveBeenCalledWith("streams");
  });
});
