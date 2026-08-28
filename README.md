# StreamSnap

A [GeoLibre](https://geolibre.app/) plugin for matching river monitoring sites to the stream
segment they actually sit on, then snapping them onto it.

Automatic nearest-segment matching gets most sites right; the ones it doesn't are the reason this
plugin exists. StreamSnap walks you through every site one at a time, shows only the segments near
it, and lets you fix a match with a single click on the map.

## What it does

- **Match automatically.** Every site is matched to its nearest stream segment, building the
  `match_table`. This is the required first step.
- **Review one site at a time.** Previous/Next step through the sites. The map frames the current
  site, draws the candidate segments within the search radius in amber, and the matched one in red.
- **Fix a match with one click.** Click any candidate segment on the map, or a row in the panel's
  candidate list. The row's `manual` column flips to `true` until you reset it.
- **Write the results back to the workspace.** `match_table` becomes a GeoLibre attribute-table
  layer; `snapped` becomes a point layer of every matched site projected onto its segment.

Only segments within the search radius are measured and drawn, so review stays fast on a large
network.

## Install

```bash
pnpm install
pnpm install:geolibre     # build, then copy into GeoLibre Desktop's plugins directory
```

Restart GeoLibre Desktop. On macOS the target is
`~/Library/Application Support/org.geolibre.desktop/plugins/streamsnap`.

For the GeoLibre web app, serve the bundle and add its manifest URL under **Settings → Plugins**:

```bash
pnpm package:geolibre
pnpm serve:geolibre -- 8000     # then add http://localhost:8000/plugin.json
```

While developing, adding `~/Code/StreamSnap/geolibre-plugin` as a plugin directory under
**Settings → Plugins** avoids the copy step: `pnpm build` then restart.

StreamSnap opens as a right-side panel when the plugin activates. Toggle it from GeoLibre's Plugins
menu.

## Using it

Load your sites and streams into GeoLibre first, however you normally would — StreamSnap reads the
layers already in the workspace rather than importing its own.

**1. Data.** Pick the sites layer (points), the streams layer (lines), and a search radius. Then
**Match all sites**.

**2. Review.** Step through the sites. The panel shows the current match, its distance, and every
candidate within the radius. Clicking a segment on the map or a candidate row re-points the site and
marks the row manual. **Reset to automatic** restores the computed match.

**3. Output.** **Create "match_table" layer** and **Create "snapped" layer** add the results to the
workspace, where GeoLibre's own attribute table and export tools take over. Both build from the
current state, so run them after you finish reviewing — each click adds a new layer rather than
replacing the previous one.

### The match table

One row per site. Rows join back to your layers on `site_index` / `stream_index`, which are feature
positions in the sites and streams layers.

| Column | Meaning |
| --- | --- |
| `site_index` | Row of the site in the sites layer |
| `stream_index` | Row of the matched segment in the streams layer, or null if nothing was in range |
| `dist_m` | Distance from the site to the segment, in metres |
| `along_m` | Distance from the segment's start to the snapped point |
| `snap_lng`, `snap_lat` | The snapped position |
| `manual` | `false` for an automatic match, `true` once you change it |

`along_m` is a linear reference along the segment, useful for positioning a site within a reach.

`snapped` carries the same columns plus each site's original attributes. Sites with no match are
omitted from `snapped` but still present in `match_table`.

## Two things to know

**Distances are metres, not degrees.** GeoLibre renders through MapLibre, so every workspace layer
is WGS84 lon/lat. Rather than a degree tolerance — which shrinks east-west as latitude rises —
StreamSnap computes geodesic distances and takes the radius in metres. 500 m behaves consistently
anywhere; `0.005°` would not.

**Layers above 50,000 features cannot be read.** Past that threshold GeoLibre renders a vector layer
from client-side vector tiles whose backing data is private to the host, and the plugin API exposes
no way to read it. Such layers appear in the pickers marked *(too large)* and are disabled. Clip or
split the layer and reload it. Sites layers are effectively never this large; a national flowline
network can be.

## Development

```bash
pnpm typecheck        # tsc --noEmit
pnpm test             # matching and snapping unit tests
pnpm lint
pnpm build            # → geolibre-plugin/dist/{index.js,style.css}
pnpm package:geolibre # → geolibre-plugin/streamsnap-0.1.0.zip
```

`geolibre-plugin/plugin.json` must keep its `id`, `name`, and `version` in sync with the plugin
object exported from `src/geolibre.ts`, or GeoLibre refuses to load the bundle.

### Layout

| Path | Role |
| --- | --- |
| `src/geolibre.ts` | Plugin entry: lifecycle and panel registration |
| `src/controller.ts` | All state and behaviour, independent of the DOM |
| `src/panel.ts` | The right panel, built as plain DOM (a plugin cannot share GeoLibre's React) |
| `src/overlay.ts` | The transient map layers for the site, candidates, and selection |
| `src/matching.ts` | Spatial index, nearest-segment search, snapping, the output collections |
| `src/workspace.ts` | Discovering and reading the vector layers already loaded in GeoLibre |
| `src/host-api.ts` | The slice of GeoLibre's plugin contract this plugin uses |

`src/workspace.ts` is the one place that depends on GeoLibre's internal id conventions. The plugin
API has no "list the workspace layers" call, so the list is derived from the MapLibre style and the
`__GEOLIBRE_LAYER_LABELS__` bridge the host publishes. If a future GeoLibre release adds a
first-class API for this, that file is the only one that needs to change.

Scaffolded from the [GeoLibre plugin template](https://github.com/opengeos/geolibre-plugin-template).
