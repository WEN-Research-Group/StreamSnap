/**
 * The slice of GeoLibre's host-plugin contract StreamSnap uses.
 *
 * The canonical definition lives in GeoLibre's `packages/plugins/src/types.ts`.
 * StreamSnap targets the current GeoLibre internal plugin interface directly.
 *
 * `maplibre-gl` is imported for types only, so it never reaches the bundle
 * GeoLibre loads (the host owns the single MapLibre instance).
 */
import type { Map as MapLibreMap } from "maplibre-gl";
import type { Feature, FeatureCollection, Geometry } from "geojson";

/**
 * Where a plugin right panel docks. `replace-style` shares one rail with the
 * built-in Style panel, which is what a workbench-style plugin wants: the two
 * never compete for horizontal space.
 */
export type GeoLibreRightPanelDock =
  | "left-of-layers"
  | "right-of-layers"
  | "left-of-style"
  | "right-of-style"
  | "replace-style"
  | "replace-layers";

export interface GeoLibreRightPanelRegistration {
  id: string;
  title: string | (() => string);
  dock?: GeoLibreRightPanelDock;
  defaultWidth?: number;
  /**
   * Fill the panel body. Called once with an empty container that stays mounted
   * across collapse, so DOM state persists. The returned function runs when the
   * panel closes or is unregistered.
   */
  render: (container: HTMLElement) => void | (() => void);
}

export interface GeoLibreLayerSummary {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
}

export interface GeoLibreAppAPI {
  /**
   * Register vector data as a first-class layer in the Layers panel. Geometry is
   * nullable: GeoLibre renders a null-geometry collection as an attribute table.
   */
  addGeoJsonLayer: (
    name: string,
    data: FeatureCollection<Geometry | null>,
    sourcePath?: string,
  ) => string;
  unregisterExternalNativeLayer: (id: string) => void;
  listLayers: () => GeoLibreLayerSummary[];
  getLayerFeatures: (id: string) => Feature<Geometry | null>[];
  getMap: () => MapLibreMap;
  registerRightPanel: (panel: GeoLibreRightPanelRegistration) => () => void;
  openRightPanel: (id: string) => boolean;
  closeRightPanel: (id: string) => void;
}

export interface GeoLibrePlugin {
  /** Must match `plugin.json`. */
  id: string;
  name: string;
  version: string;
  activate: (app: GeoLibreAppAPI) => boolean | void | Promise<boolean | void>;
  deactivate: (app: GeoLibreAppAPI) => void;
}
