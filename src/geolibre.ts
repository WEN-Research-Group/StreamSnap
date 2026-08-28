/**
 * StreamSnap's GeoLibre entry point.
 *
 * The plugin owns no map control: its whole surface is a right-side workspace
 * panel plus a transient map overlay.
 */
import { StreamSnapController } from "./controller";
import type { GeoLibreAppAPI, GeoLibrePlugin } from "./host-api";
import { renderPanel } from "./panel";
import "./styles.css";

const PANEL_ID = "streamsnap-panel";

let controller: StreamSnapController | null = null;
let unregisterPanel: (() => void) | null = null;

export const plugin: GeoLibrePlugin = {
  id: "streamsnap",
  name: "StreamSnap",
  version: "0.1.0",

  activate(app: GeoLibreAppAPI) {
    const map = app.getMap?.();
    if (!map) return false;

    controller = new StreamSnapController(app, map);
    unregisterPanel =
      app.registerRightPanel?.({
        id: PANEL_ID,
        title: "StreamSnap",
        // Shares one rail with the built-in Style panel, so the two never
        // compete for width.
        dock: "replace-style",
        defaultWidth: 340,
        render: (container) => renderPanel(container, controller!),
      }) ?? null;
    app.openRightPanel?.(PANEL_ID);
  },

  deactivate(app: GeoLibreAppAPI) {
    app.closeRightPanel?.(PANEL_ID);
    unregisterPanel?.();
    unregisterPanel = null;
    controller?.destroy();
    controller = null;
  },
};

export default plugin;
