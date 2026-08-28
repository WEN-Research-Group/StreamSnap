/**
 * The right-panel UI, built as plain DOM.
 *
 * An external plugin cannot share GeoLibre's React, so the host's panel contract
 * hands over an empty container. The static chrome is built once; everything
 * that depends on state is re-rendered from `controller.snapshot()` whenever the
 * controller emits, which keeps the panel a pure projection of the state.
 */
import { DEFAULT_RADIUS_M, type Snapshot, type StreamSnapController } from "./controller";
import type { WorkspaceLayer } from "./workspace";

export function renderPanel(container: HTMLElement, controller: StreamSnapController): () => void {
  container.classList.add("streamsnap");

  const setup = section("1. Data");
  const sitesSelect = labelledSelect("Sites (points)");
  const streamsSelect = labelledSelect("Streams (lines)");

  const radiusInput = document.createElement("input");
  radiusInput.type = "number";
  radiusInput.min = "1";
  radiusInput.step = "50";
  radiusInput.value = String(DEFAULT_RADIUS_M);
  radiusInput.className = "streamsnap-input";

  const matchButton = button("Match all sites", "streamsnap-primary");
  const status = document.createElement("p");
  status.className = "streamsnap-status";

  setup.append(
    sitesSelect.wrapper,
    streamsSelect.wrapper,
    field("Search radius (m)", radiusInput),
    matchButton,
    status,
  );

  const review = section("2. Review");
  const nav = document.createElement("div");
  nav.className = "streamsnap-nav";
  const previousButton = button("‹ Previous");
  const position = document.createElement("span");
  position.className = "streamsnap-position";
  const nextButton = button("Next ›");
  nav.append(previousButton, position, nextButton);

  const siteHeading = document.createElement("p");
  siteHeading.className = "streamsnap-site";
  const matchSummary = document.createElement("p");
  matchSummary.className = "streamsnap-match";
  const resetButton = button("Reset to automatic");
  const candidateList = document.createElement("ul");
  candidateList.className = "streamsnap-candidates";

  review.append(nav, siteHeading, matchSummary, resetButton, candidateList);

  const output = section("3. Output");
  const tableButton = button("Create “match_table” layer");
  const snapButton = button("Create “snapped” layer");
  output.append(tableButton, snapButton);

  container.append(setup, review, output);

  sitesSelect.element.addEventListener("change", () => {
    void controller.chooseSites(sitesSelect.element.value);
  });
  streamsSelect.element.addEventListener("change", () => {
    void controller.chooseStreams(streamsSelect.element.value);
  });
  radiusInput.addEventListener("change", () => controller.setRadius(Number(radiusInput.value)));
  matchButton.addEventListener("click", () => void controller.match());
  previousButton.addEventListener("click", () => controller.previous());
  nextButton.addEventListener("click", () => controller.next());
  resetButton.addEventListener("click", () => controller.resetCurrent());
  tableButton.addEventListener("click", () => controller.createMatchTableLayer());
  snapButton.addEventListener("click", () => controller.createSnappedLayer());

  const update = () => {
    const state = controller.snapshot();

    fillLayerOptions(sitesSelect.element, state.siteLayers, state.sitesLayerId);
    fillLayerOptions(streamsSelect.element, state.streamLayers, state.streamsLayerId);
    if (document.activeElement !== radiusInput) radiusInput.value = String(state.radius);
    matchButton.disabled = !controller.canMatch;
    status.textContent = state.message;

    const reviewing = state.site !== null && state.row !== null;
    review.hidden = !reviewing;
    output.hidden = !reviewing;
    if (!reviewing) return;

    renderReview(state, {
      position,
      previousButton,
      nextButton,
      siteHeading,
      matchSummary,
      resetButton,
      candidateList,
      onSelect: (segmentIndex) => controller.selectSegment(segmentIndex),
    });
  };

  const unsubscribe = controller.subscribe(update);
  update();
  return unsubscribe;
}

interface ReviewElements {
  position: HTMLElement;
  previousButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  siteHeading: HTMLElement;
  matchSummary: HTMLElement;
  resetButton: HTMLButtonElement;
  candidateList: HTMLElement;
  onSelect: (segmentIndex: number) => void;
}

function renderReview(state: Snapshot, ui: ReviewElements): void {
  const site = state.site!;
  const row = state.row!;

  ui.position.textContent = `${state.current + 1} / ${state.rows.length}`;
  ui.previousButton.disabled = state.current === 0;
  ui.nextButton.disabled = state.current === state.rows.length - 1;
  ui.siteHeading.textContent = `Site ${site.featureIndex}`;
  ui.resetButton.disabled = !row.manual;

  if (row.stream_index === null) {
    ui.matchSummary.textContent = "No segment found. Widen the radius, or pick one below.";
    ui.matchSummary.className = "streamsnap-match streamsnap-unmatched";
  } else {
    ui.matchSummary.textContent = `Segment ${row.stream_index} · ${formatMetres(row.dist_m)}`;
    ui.matchSummary.className = `streamsnap-match ${row.manual ? "streamsnap-manual" : ""}`;
  }

  ui.candidateList.replaceChildren();
  if (!state.candidates.length) {
    const empty = document.createElement("li");
    empty.className = "streamsnap-empty";
    empty.textContent = `No segments within ${formatMetres(state.radius)}.`;
    ui.candidateList.append(empty);
    return;
  }

  for (const candidate of state.candidates) {
    const segment = state.segments[candidate.segmentIndex];
    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "streamsnap-candidate";
    choice.classList.toggle("streamsnap-selected", segment.featureIndex === row.stream_index);
    choice.append(
      labelSpan(`Segment ${segment.featureIndex}`),
      labelSpan(formatMetres(candidate.distance), "distance"),
    );
    choice.addEventListener("click", () => ui.onSelect(candidate.segmentIndex));

    const item = document.createElement("li");
    item.append(choice);
    ui.candidateList.append(item);
  }
}

/** Rebuild a layer select in place, preserving the caller's chosen value. */
function fillLayerOptions(
  select: HTMLSelectElement,
  layers: WorkspaceLayer[],
  selected: string | null,
): void {
  const signature = layers.map((layer) => `${layer.layerId}:${layer.name}`).join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren();
    select.append(new Option(layers.length ? "Choose a layer…" : "No layers loaded", ""));
    for (const layer of layers) {
      // A tiled layer stays listed but unusable, so the reason is obvious.
      const option = new Option(
        layer.tiled ? `${layer.name} (too large)` : layer.name,
        layer.layerId,
      );
      option.disabled = layer.tiled;
      select.append(option);
    }
  }
  select.value = selected ?? "";
}

function section(title: string): HTMLElement {
  const element = document.createElement("section");
  element.className = "streamsnap-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  element.append(heading);
  return element;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "streamsnap-field";
  const text = document.createElement("span");
  text.textContent = label;
  wrapper.append(text, control);
  return wrapper;
}

function labelledSelect(label: string): { wrapper: HTMLElement; element: HTMLSelectElement } {
  const element = document.createElement("select");
  element.className = "streamsnap-input";
  return { wrapper: field(label, element), element };
}

function button(label: string, className = ""): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `streamsnap-button ${className}`.trim();
  element.textContent = label;
  return element;
}

function labelSpan(text: string, className = ""): HTMLElement {
  const element = document.createElement("span");
  if (className) element.className = `streamsnap-${className}`;
  element.textContent = text;
  return element;
}

function formatMetres(value: number | null): string {
  if (value === null) return "—";
  return value < 1000 ? `${value.toFixed(1)} m` : `${(value / 1000).toFixed(2)} km`;
}
