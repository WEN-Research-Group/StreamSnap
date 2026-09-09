/**
 * StreamSnap's GeoLibre entry point.
 *
 * The plugin owns no map control: its whole surface is a right-side workspace
 * panel plus a transient map overlay.
 */
import { StreamSnapController } from "./controller";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "./host-api";
import { renderPanel } from "./panel";
import {
  id as pluginId,
  name as pluginName,
  version as pluginVersion,
} from "../geolibre-plugin/plugin.json" with { type: "json" };
import "./styles.css";

const PANEL_ID = "streamsnap-panel";

let controller: StreamSnapController | null = null;
let unregisterPanel: (() => void) | null = null;

export const plugin: GeoLibrePlugin = {
  id: pluginId,
  name: pluginName,
  version: pluginVersion,

  activate(app: GeoLibreAppAPI) {
    const map = app.getMap();

    controller = new StreamSnapController(app, map);
    unregisterPanel = app.registerRightPanel({
      id: PANEL_ID,
      title: pluginName,
      dock: "replace-style",
      defaultWidth: 340,
      render: (container) => renderPanel(container, controller!),
    });
    app.openRightPanel(PANEL_ID);
  },

  deactivate(app: GeoLibreAppAPI) {
    app.closeRightPanel(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    controller?.destroy();
    controller = null;
  },
};

export default plugin;
