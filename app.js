const ROW_HEIGHT = 42;
const WRAPPED_LINE_HEIGHT = 16;
const ROW_VERTICAL_SPACE = 20;
const OVERSCAN = 12;
const SEARCH_DEBOUNCE_MS = 50;
const RESIZE_DEBOUNCE_MS = 80;
const STORAGE_KEY = "log-viewer-settings-v1";
const levels = ["UNK", "TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

function readSettings() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || {}; } catch { return {}; }
}

const saved = readSettings();
const state = {
  raw: "",
  records: [],
  visible: [],
  offsets: [0],
  totalHeight: 0,
  renderedStart: -1,
  renderedEnd: -1,
  matches: [],
  currentMatch: -1,
  selectedLevels: new Set(saved.levelSelectionExplicit && Array.isArray(saved.selectedLevels) ? saved.selectedLevels : (Array.isArray(saved.selectedLevels) && saved.selectedLevels.length ? saved.selectedLevels : levels)),
  hiddenApplications: new Set(Array.isArray(saved.hiddenApplications) ? saved.hiddenApplications : []),
  search: "",
  caseSensitive: Boolean(saved.caseSensitive),
  regexSearch: Boolean(saved.regexSearch),
  searchMode: saved.searchMode === "filter" ? "filter" : "jump",
  sidebarHidden: Boolean(saved.sidebarHidden),
  sort: saved.sort === "descending" ? "descending" : "ascending",
  replacementRules: Array.isArray(saved.replacementRules) ? saved.replacementRules.filter((rule) => rule && typeof rule.find === "string" && typeof rule.replace === "string") : []
};
if (!saved.levelSelectionIncludesUnk) state.selectedLevels.add("UNK");

const $ = (id) => document.getElementById(id);
const els = {
  file: $("fileInput"), status: $("fileStatus"), search: $("searchInput"), case: $("caseToggle"), regex: $("regexToggle"), clear: $("clearSearch"), jumpMode: $("jumpMode"), filterMode: $("filterMode"), searchUp: $("searchUp"), searchDown: $("searchDown"), sidebarToggle: $("sidebarToggle"), sidebarResize: $("sidebarResize"), workbenchBody: document.querySelector(".workbench-body"),
  parserFields: $("parserFields"), parserDetection: $("parserDetection"), preset: $("parserPreset"), split: $("splitPattern"), time: $("timePattern"), level: $("levelPattern"), app: $("appPattern"), wrap: $("wrapToggle"), formatJson: $("formatJsonToggle"),
  error: $("patternError"), reparse: $("reparseButton"), parserConfig: $("parserConfig"), importParserConfig: $("importParserConfig"), copyParserConfig: $("copyParserConfig"), levelFilters: $("levelFilters"), applicationFilters: $("applicationFilters"), timeSortToggle: $("timeSortToggle"),
  replacementRules: $("replacementRules"), addReplacement: $("addReplacement"), applyReplacements: $("applyReplacements"),
  viewport: $("logViewport"), empty: $("emptyState"), space: $("virtualSpace"), rows: $("virtualRows"), count: $("resultCount"), template: $("rowTemplate")
};
let searchDebounceTimer = null;
let layoutResizeTimer = null;
let scrollFrame = null;
let parserController;
const textMeasureContext = document.createElement("canvas").getContext("2d");
textMeasureContext.font = '12px Consolas, "SFMono-Regular", Menlo, monospace';

function saveSettings() {
  const columnWidths = {};
  ["app", "time", "level", "message"].forEach((name) => { columnWidths[name] = getComputedStyle(els.viewport).getPropertyValue(`--${name}-width`).trim(); });
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
      ...(parserController ? parserController.getSettings() : {}),
      wrap: els.wrap.checked,
      formatJson: els.formatJson.checked,
      selectedLevels: [...state.selectedLevels],
      levelSelectionExplicit: true,
      levelSelectionIncludesUnk: true,
      hiddenApplications: [...state.hiddenApplications],
      caseSensitive: state.caseSensitive,
      regexSearch: state.regexSearch,
      searchMode: state.searchMode,
      sidebarHidden: state.sidebarHidden,
      sidebarWidth: getComputedStyle(els.workbenchBody).getPropertyValue("--sidebar-width").trim(),
      sort: state.sort,
      replacementRules: state.replacementRules,
      columnWidths
    }));
  } catch { /* The viewer still works when browser storage is unavailable. */ }
}

function restoreSettings() {
  els.wrap.checked = saved.wrap !== false;
  els.formatJson.checked = Boolean(saved.formatJson);
  els.viewport.classList.toggle("wrap-enabled", els.wrap.checked);
  els.case.classList.toggle("active", state.caseSensitive);
  els.regex.classList.toggle("active", state.regexSearch);
  renderSearchMode();
  if (/^\d+(?:\.\d+)?px$/.test(saved.sidebarWidth)) setSidebarWidth(parseFloat(saved.sidebarWidth), false);
  renderSidebarState();
  if (saved.columnWidths) {
    ["app", "time", "level", "message"].forEach((name) => { if (/^\d+(?:\.\d+)?px$/.test(saved.columnWidths[name])) els.viewport.style.setProperty(`--${name}-width`, saved.columnWidths[name]); });
  }
  renderSortState();
}

function makeLevelFilters() {
  levels.forEach((level) => {
    const button = document.createElement("button");
    button.className = "chip";
    button.dataset.level = level;
    const label = document.createElement("span");
    label.textContent = level;
    const count = document.createElement("span");
    count.className = "chip-count";
    count.textContent = "0";
    button.append(label, count);
    button.classList.toggle("active", state.selectedLevels.has(level));
    button.addEventListener("click", () => {
      state.selectedLevels.has(level) ? state.selectedLevels.delete(level) : state.selectedLevels.add(level);
      button.classList.toggle("active");
      saveSettings();
      updateVisible();
    });
    els.levelFilters.append(button);
  });
}

function renderLevelCounts(records) {
  const counts = Object.fromEntries(levels.map((level) => [level, 0]));
  records.forEach((record) => { if (record.level in counts) counts[record.level] += 1; });
  els.levelFilters.querySelectorAll("[data-level]").forEach((button) => {
    button.querySelector(".chip-count").textContent = counts[button.dataset.level].toLocaleString();
  });
}

function decodeReplacementValue(value) {
  return value.replace(/\\u([\da-fA-F]{4})|\\(n|r|t|\\)/g, (match, unicode, escape) => {
    if (unicode) return String.fromCharCode(parseInt(unicode, 16));
    return { n: "\n", r: "\r", t: "\t", "\\": "\\" }[escape];
  });
}

function replaceLogStrings(text) {
  return state.replacementRules.reduce((result, rule) => {
    const find = decodeReplacementValue(rule.find);
    return find ? result.split(find).join(decodeReplacementValue(rule.replace)) : result;
  }, text);
}

function applyReplacementRules() {
  try {
    els.error.textContent = "";
    saveSettings();
    if (state.raw) parseRecords();
  } catch (error) { els.error.textContent = error.message; }
}

function renderReplacementRules() {
  const fragment = document.createDocumentFragment();
  state.replacementRules.forEach((rule, index) => {
    const row = document.createElement("div");
    row.className = "replacement-rule";
    const find = document.createElement("input");
    find.value = rule.find;
    find.placeholder = "Find";
    find.setAttribute("aria-label", `Find string for replacement ${index + 1}`);
    find.spellcheck = false;
    const replace = document.createElement("input");
    replace.value = rule.replace;
    replace.placeholder = "Replace with";
    replace.setAttribute("aria-label", `Replacement string for replacement ${index + 1}`);
    replace.spellcheck = false;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove-replacement";
    remove.textContent = "x";
    remove.title = `Remove replacement ${index + 1}`;
    remove.setAttribute("aria-label", remove.title);
    find.addEventListener("input", () => { rule.find = find.value; });
    replace.addEventListener("input", () => { rule.replace = replace.value; });
    remove.addEventListener("click", () => {
      state.replacementRules.splice(index, 1);
      renderReplacementRules();
      applyReplacementRules();
    });
    row.append(find, replace, remove);
    fragment.append(row);
  });
  if (!state.replacementRules.length) {
    const empty = document.createElement("span");
    empty.className = "replacement-placeholder";
    empty.textContent = "No replacements";
    fragment.append(empty);
  }
  els.replacementRules.replaceChildren(fragment);
}

function parseRecords() {
  parserController.parse(state.raw);
}

parserController = LogParser.createController({
  elements: {
    fields: els.parserFields, detection: els.parserDetection,
    preset: els.preset, split: els.split, time: els.time, level: els.level, app: els.app,
    error: els.error, reparse: els.reparse, config: els.parserConfig,
    importConfig: els.importParserConfig, copyConfig: els.copyParserConfig
  },
  saved,
  getText: () => state.raw,
  acceptRecords: (records) => {
    state.records = records.map((record) => ({ ...record, message: replaceLogStrings(record.message) }));
    populateApps();
    updateVisible();
  },
  settingsChanged: saveSettings
});

function searchMatches(record) {
  if (!state.search) return true;
  const haystack = `${record.app} ${record.time} ${record.level} ${record.message}`;
  try {
    if (state.regexSearch) return new RegExp(state.search, state.caseSensitive ? "" : "i").test(haystack);
    return (state.caseSensitive ? haystack : haystack.toLowerCase()).includes(state.caseSensitive ? state.search : state.search.toLowerCase());
  } catch { return false; }
}

function applySearch() {
  window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = null;
  state.search = els.search.value;
  updateVisible();
}

function updateVisible() {
  const allLevelsSelected = state.selectedLevels.size === levels.length;
  let applicable = state.records.filter((record) => !state.hiddenApplications.has(record.app));
  if (state.searchMode === "filter" && state.search) applicable = applicable.filter(searchMatches);
  renderLevelCounts(applicable);
  const filtered = applicable.filter((record) => allLevelsSelected || state.selectedLevels.has(record.level));
  const direction = state.sort === "ascending" ? 1 : -1;
  filtered.sort((a, b) => direction * a.time.localeCompare(b.time, undefined, { numeric: true }));
  state.visible = filtered;
  state.matches = [];
  if (state.searchMode === "jump" && state.search) {
    state.visible.forEach((record, index) => { if (searchMatches(record)) state.matches.push(index); });
  }
  state.currentMatch = state.matches.length ? 0 : -1;
  els.viewport.scrollTop = 0;
  renderMeta();
  renderSearchMode();
  renderRows(true);
}

function populateApps() {
  const apps = [...new Set(state.records.map((item) => item.app).filter((app) => app !== "-"))].sort();
  const fragment = document.createDocumentFragment();
  if (!apps.length) {
    const placeholder = document.createElement("span");
    placeholder.className = "application-placeholder";
    placeholder.textContent = "No applications";
    fragment.append(placeholder);
  }
  apps.forEach((app) => {
    const hidden = state.hiddenApplications.has(app);
    const row = document.createElement("div");
    row.className = `application-item${hidden ? " hidden-app" : ""}`;
    const button = document.createElement("button");
    button.className = `app-visibility${hidden ? " app-hidden" : ""}`;
    button.type = "button";
    button.setAttribute("aria-pressed", String(!hidden));
    button.setAttribute("aria-label", `${hidden ? "Show" : "Hide"} ${app}`);
    button.title = `${hidden ? "Show" : "Hide"} ${app}`;
    button.innerHTML = '<span class="eye-icon" aria-hidden="true"></span>';
    const name = document.createElement("span");
    name.className = "application-name";
    name.textContent = app;
    name.title = app;
    button.addEventListener("click", () => {
      state.hiddenApplications.has(app) ? state.hiddenApplications.delete(app) : state.hiddenApplications.add(app);
      populateApps();
      saveSettings();
      updateVisible();
    });
    row.append(button, name);
    fragment.append(row);
  });
  els.applicationFilters.replaceChildren(fragment);
}

function renderMeta() {
  const total = state.records.length;
  const hasVisible = state.visible.length > 0;
  prepareLayout();
  if (state.searchMode === "jump" && state.search) {
    const current = state.currentMatch >= 0 ? state.currentMatch + 1 : 0;
    els.count.textContent = `${current} / ${state.matches.length.toLocaleString()} matches`;
  } else {
    els.count.textContent = total ? `${state.visible.length.toLocaleString()} / ${total.toLocaleString()} records` : "No records found";
  }
  els.empty.hidden = true;
  els.space.hidden = !hasVisible;
  els.space.style.height = `${state.totalHeight}px`;
}

function renderSortState() {
  const ascending = state.sort === "ascending";
  els.timeSortToggle.textContent = ascending ? "\u2191" : "\u2193";
  els.timeSortToggle.title = ascending ? "Sorted ascending" : "Sorted descending";
  els.timeSortToggle.setAttribute("aria-label", els.timeSortToggle.title);
}

function renderSearchMode() {
  const jumping = state.searchMode === "jump";
  els.jumpMode.classList.toggle("active", jumping);
  els.filterMode.classList.toggle("active", !jumping);
  els.searchUp.disabled = !jumping || !state.matches.length;
  els.searchDown.disabled = !jumping || !state.matches.length;
}

function jumpToMatch(step) {
  if (state.searchMode !== "jump" || !state.matches.length) return;
  state.currentMatch = (state.currentMatch + step + state.matches.length) % state.matches.length;
  const rowIndex = state.matches[state.currentMatch];
  els.viewport.scrollTop = Math.max(0, state.offsets[rowIndex] - Math.floor(els.viewport.clientHeight / 2));
  renderMeta();
  renderRows(true);
}

function renderSidebarState() {
  els.workbenchBody.classList.toggle("sidebar-hidden", state.sidebarHidden);
  const label = state.sidebarHidden ? "Show sidebar" : "Hide sidebar";
  els.sidebarToggle.setAttribute("aria-label", label);
  els.sidebarToggle.title = label;
  els.sidebarToggle.setAttribute("aria-expanded", String(!state.sidebarHidden));
}

function setSidebarWidth(width, persist = true) {
  const maximum = Math.max(180, els.workbenchBody.clientWidth - 320);
  const constrained = Math.min(maximum, Math.max(180, width));
  els.workbenchBody.style.setProperty("--sidebar-width", `${constrained}px`);
  els.sidebarResize.setAttribute("aria-valuemin", "180");
  els.sidebarResize.setAttribute("aria-valuemax", String(maximum));
  els.sidebarResize.setAttribute("aria-valuenow", String(Math.round(constrained)));
  if (persist) saveSettings();
}

function setSort(direction) {
  state.sort = direction;
  renderSortState();
  saveSettings();
  updateVisible();
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", "'":"&#39;", '"':"&quot;" })[character]);
}

function highlight(value) {
  const safe = escapeHtml(value);
  if (!state.search) return safe;
  if (!state.regexSearch) {
    const source = String(value);
    const haystack = state.caseSensitive ? source : source.toLowerCase();
    const needle = state.caseSensitive ? state.search : state.search.toLowerCase();
    let result = "";
    let position = 0;
    let match = haystack.indexOf(needle, position);
    while (match !== -1) {
      result += `${escapeHtml(source.slice(position, match))}<mark>${escapeHtml(source.slice(match, match + state.search.length))}</mark>`;
      position = match + state.search.length;
      match = haystack.indexOf(needle, position);
    }
    return result + escapeHtml(source.slice(position));
  }
  try {
    return safe.replace(new RegExp(`(${state.search})`, `g${state.caseSensitive ? "" : "i"}`), "<mark>$1</mark>");
  } catch { return safe; }
}

function formatEmbeddedJson(message) {
  for (let start = 0; start < message.length; start += 1) {
    const opener = message[start];
    if (opener !== "{") continue;
    const closer = "}";
    const end = message.lastIndexOf(closer);
    if (end <= start) continue;
    const candidate = message.slice(start, end + 1);
    const looksLikeObject = opener === "{" && /"(?:\\.|[^"\\])*"\s*:/.test(candidate);
    if (!looksLikeObject) continue;

    let formatted = "";
    let indentation = 0;
    let inString = false;
    let escaped = false;
    const indent = () => "  ".repeat(indentation);

    for (const character of candidate) {
      if (inString) {
        formatted += character;
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') { inString = true; formatted += character; }
      else if (character === "{" || character === "[") { indentation += 1; formatted += `${character}\n${indent()}`; }
      else if (character === "}" || character === "]") { indentation = Math.max(0, indentation - 1); formatted += `\n${indent()}${character}`; }
      else if (character === ",") formatted += `,\n${indent()}`;
      else if (character === ":") formatted += ": ";
      else if (!/\s/.test(character)) formatted += character;
    }
    const prefix = message.slice(0, start).trimEnd();
    return `${prefix}${prefix ? "\n" : ""}${formatted}${message.slice(end + 1)}`;
  }
  return message;
}

function prepareLayout() {
  const styles = getComputedStyle(els.viewport);
  const fixedWidth = ["app", "time", "level"].reduce((width, name) => width + parseFloat(styles.getPropertyValue(`--${name}-width`)), 0);
  const messageWidth = Math.max(1, els.viewport.clientWidth - fixedWidth - 20);
  const wrapping = els.wrap.checked;
  let offset = 0;
  state.offsets = [0];
  state.visible.forEach((record) => {
    record.displayMessage = els.formatJson.checked ? formatEmbeddedJson(record.message) : record.message;
    if (record.measuredMessage !== record.displayMessage) {
      record.measuredMessage = record.displayMessage;
      record.lineWidths = record.displayMessage.split("\n").map((line) => textMeasureContext.measureText(line.replace(/\t/g, "        ")).width);
    }
    const displayLines = wrapping
      ? record.lineWidths.reduce((count, width) => count + Math.max(1, Math.ceil(width / messageWidth)), 0)
      : 1;
    record.hasMultilineMessage = displayLines > 1;
    const measuredHeight = record.measuredRowWidth === messageWidth && record.measuredRowMessage === record.displayMessage
      ? record.measuredRowHeight
      : null;
    record.rowHeight = measuredHeight || Math.max(ROW_HEIGHT, displayLines * WRAPPED_LINE_HEIGHT + ROW_VERTICAL_SPACE);
    offset += record.rowHeight;
    state.offsets.push(offset);
  });
  state.totalHeight = offset;
  state.messageWidth = messageWidth;
}

function rebuildOffsets() {
  let offset = 0;
  state.offsets = [0];
  state.visible.forEach((record) => {
    offset += record.rowHeight;
    state.offsets.push(offset);
  });
  state.totalHeight = offset;
  els.space.style.height = `${state.totalHeight}px`;
}

function rowAtOffset(offset) {
  let low = 0;
  let high = state.visible.length;
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2);
    if (state.offsets[middle] <= offset) low = middle;
    else high = middle - 1;
  }
  return Math.min(low, Math.max(0, state.visible.length - 1));
}

function relayoutRows() {
  const anchorIndex = state.visible.length ? rowAtOffset(els.viewport.scrollTop) : 0;
  const anchorOffset = state.visible.length ? els.viewport.scrollTop - state.offsets[anchorIndex] : 0;
  prepareLayout();
  els.space.style.height = `${state.totalHeight}px`;
  if (state.visible.length) {
    const offsetWithinRow = Math.min(anchorOffset, Math.max(0, state.visible[anchorIndex].rowHeight - 1));
    els.viewport.scrollTop = state.offsets[anchorIndex] + offsetWithinRow;
  }
  renderRows(true);
}

function scheduleRelayout() {
  window.clearTimeout(layoutResizeTimer);
  layoutResizeTimer = window.setTimeout(() => {
    layoutResizeTimer = null;
    relayoutRows();
  }, RESIZE_DEBOUNCE_MS);
}

function renderRows(force = false, measurementPass = 0) {
  const start = Math.max(0, rowAtOffset(els.viewport.scrollTop) - OVERSCAN);
  const renderThrough = els.viewport.scrollTop + els.viewport.clientHeight + OVERSCAN * ROW_HEIGHT;
  let end = start;
  while (end < state.visible.length && state.offsets[end] < renderThrough) end += 1;
  if (!force && start === state.renderedStart && end === state.renderedEnd) return;
  state.renderedStart = start;
  state.renderedEnd = end;
  const fragment = document.createDocumentFragment();
  for (let i = start; i < end; i += 1) {
    const record = state.visible[i];
    const node = els.template.content.firstElementChild.cloneNode(true);
    node.style.transform = `translateY(${state.offsets[i]}px)`;
    node.style.height = `${record.rowHeight}px`;
    node.classList.toggle("alternate-row", i % 2 === 1);
    node.classList.toggle("has-multiline-message", record.hasMultilineMessage);
    node.classList.toggle("current-match", state.searchMode === "jump" && state.matches[state.currentMatch] === i);
    node.querySelector(".app-cell").innerHTML = highlight(record.app);
    node.querySelector(".time-cell").innerHTML = highlight(record.time);
    const level = node.querySelector(".level-cell");
    level.textContent = record.level;
    level.classList.add(`level-${record.level.toLowerCase()}`);
    const message = node.querySelector(".message-cell");
    message.classList.toggle("multiline-message", record.hasMultilineMessage);
    const content = document.createElement("span");
    content.className = "message-content";
    content.innerHTML = highlight(record.displayMessage);
    message.append(content);
    node.title = record.raw;
    fragment.append(node);
  }
  els.rows.replaceChildren(fragment);
  if (measurementPass < 3 && els.wrap.checked) {
    let changed = false;
    [...els.rows.children].forEach((node, renderedIndex) => {
      const record = state.visible[start + renderedIndex];
      const message = node.querySelector(".message-cell");
      const content = message.querySelector(".message-content");
      const styles = getComputedStyle(message);
      const rowStyles = getComputedStyle(node);
      const padding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
      const borders = parseFloat(rowStyles.borderTopWidth) + parseFloat(rowStyles.borderBottomWidth);
      const measuredHeight = Math.max(ROW_HEIGHT, Math.ceil(content.getBoundingClientRect().height + padding + borders));
      record.measuredRowWidth = state.messageWidth;
      record.measuredRowMessage = record.displayMessage;
      record.measuredRowHeight = measuredHeight;
      if (record.rowHeight !== measuredHeight) {
        record.rowHeight = measuredHeight;
        changed = true;
      }
    });
    if (changed) {
      rebuildOffsets();
      renderRows(true, measurementPass + 1);
    }
  }
}

function loadLog(text, name, size) {
  state.raw = text;
  els.status.textContent = `${name} / ${(size / 1024 / 1024).toFixed(2)} MB`;
  parseRecords();
}

els.file.addEventListener("change", async ({ target }) => {
  const file = target.files[0];
  if (!file) return;
  els.status.textContent = `Reading ${file.name}...`;
  try { loadLog(await file.text(), file.name, file.size); } catch (error) { els.error.textContent = error.message; }
});
els.addReplacement.addEventListener("click", () => {
  state.replacementRules.push({ find: "", replace: "" });
  renderReplacementRules();
  els.replacementRules.querySelector(".replacement-rule:last-child input")?.focus();
});
els.applyReplacements.addEventListener("click", applyReplacementRules);
els.search.addEventListener("input", () => {
  window.clearTimeout(searchDebounceTimer);
  searchDebounceTimer = window.setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || state.searchMode !== "jump") return;
  const interactive = event.target.closest("button, input, select, textarea, [contenteditable]");
  if (interactive && event.target !== els.search) return;
  event.preventDefault();
  if (searchDebounceTimer !== null) applySearch();
  jumpToMatch(event.shiftKey ? -1 : 1);
});
els.clear.addEventListener("click", () => { els.search.value = ""; applySearch(); els.search.focus(); });
els.case.addEventListener("click", () => { state.caseSensitive = !state.caseSensitive; els.case.classList.toggle("active", state.caseSensitive); saveSettings(); applySearch(); });
els.regex.addEventListener("click", () => { state.regexSearch = !state.regexSearch; els.regex.classList.toggle("active", state.regexSearch); saveSettings(); applySearch(); });
els.jumpMode.addEventListener("click", () => { state.searchMode = "jump"; saveSettings(); updateVisible(); });
els.filterMode.addEventListener("click", () => { state.searchMode = "filter"; saveSettings(); updateVisible(); });
els.searchUp.addEventListener("click", () => jumpToMatch(-1));
els.searchDown.addEventListener("click", () => jumpToMatch(1));
els.sidebarToggle.addEventListener("click", () => { state.sidebarHidden = !state.sidebarHidden; renderSidebarState(); saveSettings(); relayoutRows(); });
els.sidebarResize.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  const startX = event.clientX;
  const startWidth = parseFloat(getComputedStyle(els.workbenchBody).getPropertyValue("--sidebar-width"));
  els.sidebarResize.classList.add("resizing");
  els.sidebarResize.setPointerCapture(event.pointerId);
  const resize = (move) => setSidebarWidth(startWidth + move.clientX - startX, false);
  const finish = () => {
    els.sidebarResize.classList.remove("resizing");
    els.sidebarResize.removeEventListener("pointermove", resize);
    els.sidebarResize.removeEventListener("pointerup", finish);
    els.sidebarResize.removeEventListener("pointercancel", finish);
    saveSettings();
    relayoutRows();
  };
  els.sidebarResize.addEventListener("pointermove", resize);
  els.sidebarResize.addEventListener("pointerup", finish);
  els.sidebarResize.addEventListener("pointercancel", finish);
});
els.sidebarResize.addEventListener("keydown", (event) => {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  const current = parseFloat(getComputedStyle(els.workbenchBody).getPropertyValue("--sidebar-width"));
  setSidebarWidth(current + (event.key === "ArrowRight" ? 10 : -10));
  relayoutRows();
});
els.timeSortToggle.addEventListener("click", () => setSort(state.sort === "ascending" ? "descending" : "ascending"));
els.wrap.addEventListener("change", () => { els.viewport.classList.toggle("wrap-enabled", els.wrap.checked); saveSettings(); relayoutRows(); });
els.formatJson.addEventListener("change", () => { saveSettings(); updateVisible(); });
els.viewport.addEventListener("scroll", () => {
  if (scrollFrame !== null) return;
  scrollFrame = window.requestAnimationFrame(() => { scrollFrame = null; renderRows(); });
}, { passive: true });
new ResizeObserver(scheduleRelayout).observe(els.viewport);

document.querySelectorAll("[data-resize]").forEach((handle) => handle.addEventListener("pointerdown", (event) => {
  event.preventDefault();
  event.stopPropagation();
  const name = handle.dataset.resize;
  const startX = event.clientX;
  const startWidth = parseFloat(getComputedStyle(els.viewport).getPropertyValue(`--${name}-width`));
  handle.setPointerCapture(event.pointerId);
  const resize = (move) => els.viewport.style.setProperty(`--${name}-width`, `${Math.max(name === "level" ? 65 : 110, startWidth + move.clientX - startX)}px`);
  const finish = () => {
    handle.removeEventListener("pointermove", resize);
    handle.removeEventListener("pointerup", finish);
    handle.removeEventListener("pointercancel", finish);
    saveSettings();
    relayoutRows();
  };
  handle.addEventListener("pointermove", resize);
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
}));

restoreSettings();
makeLevelFilters();
renderReplacementRules();
