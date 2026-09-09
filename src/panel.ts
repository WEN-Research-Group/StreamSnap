import {
  DEFAULT_MAX_SEGMENT_DISTANCE_M,
  type LayerKind,
  type Snapshot,
  type StreamSnapController,
} from "./controller";
import type { AttributeInfo } from "./matching";
import type { WorkspaceLayer } from "./workspace";

export function renderPanel(
  container: HTMLElement,
  controller: StreamSnapController,
): () => void {
  container.classList.add("streamsnap");

  const settings = document.createElement("div");
  settings.className = "streamsnap-stage";
  settings.append(stageHeading("SETTINGS"));

  const sites = layerSettings("Sites", "VECTOR - points");
  const streams = layerSettings("Streams", "VECTOR - lines");
  const distanceInput = numberInput(DEFAULT_MAX_SEGMENT_DISTANCE_M, 1, 1);
  const startButton = button("START REVIEWING", "primary");
  const settingsStatus = statusElement();
  settings.append(
    sites.root,
    separator(),
    streams.root,
    separator(),
    field("Max stream segment distance (m)", distanceInput),
    startButton,
    settingsStatus,
  );

  const review = document.createElement("div");
  review.className = "streamsnap-stage streamsnap-review-stage";
  review.append(stageHeading("REVIEW"));

  const nav = document.createElement("div");
  nav.className = "streamsnap-nav";
  const previousButton = button("Previous", "outline");
  const position = numberInput(1, 1, 1);
  position.classList.add("streamsnap-position-input", "streamsnap-tabular");
  position.setAttribute("aria-label", "Go to site number");
  position.title = "Enter a site number and press Enter";
  const positionTotal = document.createElement("span");
  positionTotal.className = "streamsnap-muted streamsnap-tabular";
  const positionControl = document.createElement("span");
  positionControl.className = "streamsnap-position-control";
  positionControl.append(position, positionTotal);
  const nextButton = button("Next", "outline");
  nav.append(previousButton, positionControl, nextButton);

  const siteSection = reviewSection("Site information");
  const siteInfo = document.createElement("dl");
  siteInfo.className = "streamsnap-properties";
  siteSection.append(siteInfo);

  const autoMatchButton = button("Auto-match", "outline");

  const streamSection = reviewSection("Stream segment");
  const matchSummary = document.createElement("p");
  matchSummary.className = "streamsnap-summary";
  const candidateList = document.createElement("ul");
  candidateList.className = "streamsnap-candidates";
  streamSection.append(matchSummary, candidateList);

  const styleSection = reviewSection("Selected segment style");
  const outlineColor = document.createElement("input");
  outlineColor.type = "color";
  outlineColor.className = "streamsnap-input streamsnap-color-input";
  const outlineWidth = numberInput(2, 0.5, 0.5);
  styleSection.append(
    field("Outline color", outlineColor),
    field("Outline width (px)", outlineWidth),
  );

  const finalizeSection = reviewSection("Finalize");
  const matchedSummary = document.createElement("p");
  matchedSummary.className = "streamsnap-summary streamsnap-tabular";
  const finalizeButton = button("Generate snapped sites", "primary");
  finalizeSection.append(matchedSummary, finalizeButton);
  const reviewStatus = statusElement();
  review.append(
    nav,
    separator(),
    siteSection,
    autoMatchButton,
    separator(),
    streamSection,
    separator(),
    styleSection,
    separator(),
    finalizeSection,
    reviewStatus,
  );

  container.append(settings, review);

  sites.select.addEventListener("change", () =>
    controller.chooseSites(sites.select.value),
  );
  streams.select.addEventListener("change", () =>
    controller.chooseStreams(streams.select.value),
  );
  distanceInput.addEventListener("change", () => {
    if (!controller.setMaxSegmentDistance(Number(distanceInput.value))) {
      distanceInput.value = String(controller.snapshot().maxSegmentDistance);
    }
  });
  startButton.addEventListener("click", () => controller.startReviewing());
  previousButton.addEventListener("click", () => controller.previous());
  nextButton.addEventListener("click", () => controller.next());
  position.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    const index = Number(position.value);
    const total = controller.snapshot().rows.length;
    if (Number.isInteger(index) && index >= 1 && index <= total) {
      controller.goto(index - 1);
    } else {
      position.value = String(controller.snapshot().current + 1);
    }
  });
  autoMatchButton.addEventListener("click", () =>
    controller.autoMatchCurrent(),
  );
  outlineColor.addEventListener("input", () =>
    controller.setSelectedOutlineColor(outlineColor.value),
  );
  outlineWidth.addEventListener("change", () => {
    if (!controller.setSelectedOutlineWidth(Number(outlineWidth.value))) {
      outlineWidth.value = String(
        controller.snapshot().selectedStyle.outlineWidth,
      );
    }
  });
  finalizeButton.addEventListener("click", () => controller.finalize());

  const update = () => {
    const state = controller.snapshot();
    const inSettings = state.stage === "settings";
    settings.hidden = !inSettings;
    review.hidden = inSettings;

    if (inSettings) {
      fillLayerOptions(sites.select, state.siteLayers, state.sitesLayerId);
      fillLayerOptions(
        streams.select,
        state.streamLayers,
        state.streamsLayerId,
      );
      renderAttributeList(
        sites.attributes,
        state.siteAttributes,
        state.siteVisibleAttributes,
        state.sitePrimaryKey,
        "sites",
        controller,
      );
      renderAttributeList(
        streams.attributes,
        state.streamAttributes,
        state.streamVisibleAttributes,
        state.streamPrimaryKey,
        "streams",
        controller,
      );
      if (document.activeElement !== distanceInput) {
        distanceInput.value = String(state.maxSegmentDistance);
      }
      startButton.disabled = !controller.canStartReviewing;
      settingsStatus.textContent =
        state.message ||
        (!state.sitesLayerId || !state.streamsLayerId
          ? "Choose point and line layers."
          : !state.sitePrimaryKey || !state.streamPrimaryKey
            ? "Choose one unique primary key for each layer."
            : "");
      return;
    }

    renderReview(state, {
      position,
      positionTotal,
      previousButton,
      nextButton,
      siteInfo,
      autoMatchButton,
      matchSummary,
      candidateList,
      outlineColor,
      outlineWidth,
      finalizeButton,
      matchedSummary,
      reviewStatus,
      controller,
    });
  };

  const unsubscribe = controller.subscribe(update);
  update();
  return unsubscribe;
}

interface ReviewElements {
  position: HTMLInputElement;
  positionTotal: HTMLElement;
  previousButton: HTMLButtonElement;
  nextButton: HTMLButtonElement;
  siteInfo: HTMLElement;
  autoMatchButton: HTMLButtonElement;
  matchSummary: HTMLElement;
  candidateList: HTMLElement;
  outlineColor: HTMLInputElement;
  outlineWidth: HTMLInputElement;
  finalizeButton: HTMLButtonElement;
  matchedSummary: HTMLElement;
  reviewStatus: HTMLElement;
  controller: StreamSnapController;
}

function renderReview(state: Snapshot, ui: ReviewElements): void {
  const site = state.site;
  if (!site) return;

  ui.position.max = String(state.rows.length);
  if (document.activeElement !== ui.position) {
    ui.position.value = String(state.current + 1);
  }
  ui.positionTotal.textContent = `of ${state.rows.length}`;
  ui.previousButton.disabled = state.current === 0;
  ui.nextButton.disabled = state.current === state.rows.length - 1;
  renderProperties(
    ui.siteInfo,
    site.properties,
    state.sitePrimaryKey!,
    state.siteVisibleAttributes,
  );

  const row = state.row;
  if (!row) {
    ui.matchSummary.textContent = "Finding the nearest stream segment…";
  } else if (row.snapped_stream_index === null) {
    ui.matchSummary.textContent = `No segment within ${formatMetres(
      state.maxSegmentDistance,
    )}.`;
  } else {
    ui.matchSummary.textContent = `${
      row.manual_revised ? "Manually revised" : "Automatic match"
    } · ${formatMetres(row.snap_distance_m)}`;
  }

  renderCandidates(ui.candidateList, state, (segmentIndex) =>
    ui.controller.selectSegment(segmentIndex),
  );

  if (document.activeElement !== ui.outlineColor) {
    ui.outlineColor.value = state.selectedStyle.outlineColor;
  }
  if (document.activeElement !== ui.outlineWidth) {
    ui.outlineWidth.value = String(state.selectedStyle.outlineWidth);
  }
  ui.finalizeButton.disabled = !ui.controller.canFinalize;
  ui.finalizeButton.textContent = state.hasSnappedOutput
    ? "Regenerate snapped sites"
    : "Generate snapped sites";
  ui.matchedSummary.textContent = `${state.matchedCount} of ${state.rows.length} matched`;
  ui.reviewStatus.textContent = state.message;
}

function renderCandidates(
  list: HTMLElement,
  state: Snapshot,
  onSelect: (segmentIndex: number) => void,
): void {
  list.replaceChildren();

  for (const candidate of state.candidates) {
    const segment = state.segments[candidate.segmentIndex];
    const selected =
      segment.properties[state.streamPrimaryKey!] ===
      state.row?.snapped_stream_key;
    const item = document.createElement("li");
    item.className = "streamsnap-candidate";
    item.classList.toggle("streamsnap-selected", selected);

    const choice = document.createElement("button");
    choice.type = "button";
    choice.className = "streamsnap-candidate-button";
    choice.append(
      textSpan(formatValue(segment.properties[state.streamPrimaryKey!])),
      textSpan(
        formatMetres(candidate.distance),
        "streamsnap-muted streamsnap-tabular",
      ),
    );
    choice.addEventListener("click", () => onSelect(candidate.segmentIndex));
    item.append(choice);

    if (selected) {
      const properties = document.createElement("dl");
      properties.className =
        "streamsnap-properties streamsnap-candidate-properties";
      renderProperties(
        properties,
        segment.properties,
        state.streamPrimaryKey!,
        state.streamVisibleAttributes,
        false,
      );
      item.append(properties);
    }
    list.append(item);
  }
}

function renderAttributeList(
  list: HTMLElement,
  attributes: AttributeInfo[],
  visibleAttributes: string[],
  primaryKey: string | null,
  kind: LayerKind,
  controller: StreamSnapController,
): void {
  list.replaceChildren();
  if (!attributes.length) {
    const empty = document.createElement("p");
    empty.className = "streamsnap-empty";
    empty.textContent = "Choose a layer to list its attributes.";
    list.append(empty);
    return;
  }

  const header = document.createElement("div");
  header.className = "streamsnap-attribute-header";
  header.append(textSpan(""), textSpan("Attribute"), textSpan("Primary key"));
  list.append(header);

  const visible = new Set(visibleAttributes);
  for (const attribute of attributes) {
    const row = document.createElement("div");
    row.className = "streamsnap-attribute";

    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "streamsnap-icon-button";
    eye.disabled = primaryKey === attribute.name;
    eye.setAttribute("aria-pressed", String(visible.has(attribute.name)));
    eye.setAttribute(
      "aria-label",
      `${visible.has(attribute.name) ? "Hide" : "Show"} ${attribute.name}`,
    );
    eye.title =
      primaryKey === attribute.name
        ? "Primary keys are always shown"
        : `${visible.has(attribute.name) ? "Hide" : "Show"} attribute`;
    eye.append(eyeIcon(visible.has(attribute.name)));
    eye.addEventListener("click", () =>
      controller.toggleAttribute(kind, attribute.name),
    );

    const name = textSpan(attribute.name);
    name.className = "streamsnap-attribute-name";

    const primary = document.createElement("input");
    primary.type = "radio";
    primary.name = `streamsnap-${kind}-primary-key`;
    primary.checked = primaryKey === attribute.name;
    primary.disabled = !attribute.unique;
    primary.setAttribute("aria-label", `Use ${attribute.name} as primary key`);
    primary.title = attribute.unique
      ? "Use as primary key"
      : "Primary keys require unique, non-empty text or integer values";
    primary.addEventListener("change", () =>
      controller.choosePrimaryKey(kind, attribute.name),
    );
    row.append(eye, name, primary);
    list.append(row);
  }
}

function renderProperties(
  container: HTMLElement,
  properties: Record<string, unknown>,
  primaryKey: string,
  visibleAttributes: string[],
  includePrimary = true,
): void {
  container.replaceChildren();
  const names = includePrimary
    ? [primaryKey, ...visibleAttributes.filter((name) => name !== primaryKey)]
    : visibleAttributes.filter((name) => name !== primaryKey);
  for (const name of names) {
    const term = document.createElement("dt");
    term.textContent = name;
    const value = document.createElement("dd");
    value.textContent = formatValue(properties[name]);
    value.title = value.textContent;
    container.append(term, value);
  }
}

function layerSettings(
  label: string,
  meta: string,
): {
  root: HTMLElement;
  select: HTMLSelectElement;
  attributes: HTMLElement;
} {
  const root = document.createElement("section");
  root.className = "streamsnap-group";
  const title = document.createElement("div");
  title.className = "streamsnap-layer-title";
  const heading = document.createElement("h3");
  heading.textContent = label;
  const type = document.createElement("span");
  type.className = "streamsnap-muted streamsnap-layer-type";
  type.textContent = meta;
  title.append(heading, type);

  const select = document.createElement("select");
  select.className = "streamsnap-select";
  const selectControl = document.createElement("div");
  selectControl.className = "streamsnap-select-wrapper";
  selectControl.append(select, chevronIcon());

  const attributeLabel = document.createElement("p");
  attributeLabel.className = "streamsnap-label";
  attributeLabel.textContent = "Attributes";
  const attributes = document.createElement("div");
  attributes.className = "streamsnap-attribute-list";
  root.append(title, selectControl, attributeLabel, attributes);
  return { root, select, attributes };
}

function fillLayerOptions(
  select: HTMLSelectElement,
  layers: WorkspaceLayer[],
  selected: string | null,
): void {
  const signature = layers
    .map((layer) => `${layer.layerId}:${layer.name}`)
    .join("|");
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren(
      new Option(layers.length ? "Choose a layer…" : "No layers loaded", ""),
    );
    for (const layer of layers) {
      select.append(new Option(layer.name, layer.layerId));
    }
  }
  select.value = selected ?? "";
}

function stageHeading(text: string): HTMLElement {
  const heading = document.createElement("h2");
  heading.className = "streamsnap-stage-heading";
  heading.textContent = text;
  return heading;
}

function reviewSection(title: string): HTMLElement {
  const section = document.createElement("section");
  section.className = "streamsnap-review-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading);
  return section;
}

function field(label: string, control: HTMLElement): HTMLElement {
  const wrapper = document.createElement("label");
  wrapper.className = "streamsnap-field";
  const text = document.createElement("span");
  text.className = "streamsnap-label";
  text.textContent = label;
  wrapper.append(text, control);
  return wrapper;
}

function numberInput(
  value: number,
  min: number,
  step: number,
): HTMLInputElement {
  const input = document.createElement("input");
  input.type = "number";
  input.value = String(value);
  input.min = String(min);
  input.step = String(step);
  input.className = "streamsnap-input";
  return input;
}

function button(
  label: string,
  variant: "primary" | "outline",
): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = `streamsnap-button streamsnap-button-${variant}`;
  element.textContent = label;
  return element;
}

function statusElement(): HTMLElement {
  const status = document.createElement("p");
  status.className = "streamsnap-status";
  status.setAttribute("aria-live", "polite");
  return status;
}

function separator(): HTMLElement {
  const element = document.createElement("hr");
  element.className = "streamsnap-separator";
  return element;
}

function textSpan(text: string, className = ""): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.textContent = text;
  return span;
}

function eyeIcon(open: boolean): SVGSVGElement {
  const svg = svgElement();
  const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
  shape.setAttribute(
    "d",
    open
      ? "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z"
      : "M3 3l18 18M10.6 5.2A11 11 0 0 1 12 5c6.5 0 10 7 10 7a14 14 0 0 1-2.1 3.1M6.6 6.6C3.6 8.6 2 12 2 12s3.5 7 10 7c1.8 0 3.3-.5 4.6-1.2M9.9 9.9a3 3 0 0 0 4.2 4.2",
  );
  svg.append(shape);
  return svg;
}

function chevronIcon(): SVGSVGElement {
  const svg = svgElement();
  svg.classList.add("streamsnap-chevron");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "m6 9 6 6 6-6");
  svg.append(path);
  return svg;
}

function svgElement(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "object") return JSON.stringify(value) ?? "—";
  return String(value);
}

function formatMetres(value: number | null): string {
  if (value === null) return "—";
  return value < 1000
    ? `${value.toFixed(1)} m`
    : `${(value / 1000).toFixed(2)} km`;
}
