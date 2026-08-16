(function () {
  "use strict";

  const patternNames = ["split", "time", "level", "app"];
  const presets = new Map();
  const detectors = [];

  function expression(value, label) {
    try { return new RegExp(value); } catch (error) { throw new Error(`${label}: ${error.message}`); }
  }

  function captured(pattern, text, fallback = "-") {
    const match = text.match(pattern);
    return match ? (match[1] ?? match.groups?.value ?? match[0]) : fallback;
  }

  function validatePatterns(patterns) {
    const missing = patternNames.filter((name) => typeof patterns[name] !== "string" || !patterns[name]);
    if (missing.length) throw new Error(`Parser config is missing: ${missing.join(", ")}`);
    const split = expression(patterns.split, "Split pattern");
    if (split.test("")) throw new Error("Split pattern must not match an empty string.");
    expression(patterns.time, "Time pattern");
    expression(patterns.level, "Level pattern");
    expression(patterns.app, "App pattern");
    return patterns;
  }

  function registerPreset(id, definition) {
    if (!id || presets.has(id)) throw new Error(`Parser preset already exists: ${id}`);
    validatePatterns(definition);
    presets.set(id, { ...definition, label: definition.label || id });
  }

  function registerDetector(detector) {
    if (typeof detector !== "function") throw new Error("Parser detector must be a function.");
    detectors.push(detector);
  }

  // Presets and detectors are registered independently so new formats do not require viewer changes.
  registerPreset("default", {
    label: "Default (Spring Boot)",
    split: String.raw`\r?\n`,
    time: String.raw`^(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)`,
    level: String.raw`\b(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\b`,
    app: String.raw`---\s+\[[^\]]+\]\s+([^\s:]+)\s*:`
  });

  registerPreset("bracketed-app", {
    label: "Bracketed app",
    split: String.raw`\r?\n`,
    time: String.raw`^\[(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?)\]`,
    level: String.raw`\[\s*(TRACE|DEBUG|INFO|WARN|ERROR|FATAL)\s*\]`,
    app: String.raw`^\[[^\]]+\]\[([^\]]+)\]`
  });

  registerDetector((text, availablePresets) => {
    let best = null;
    for (const [presetId, preset] of availablePresets) {
      const split = expression(preset.split, "Split pattern");
      const records = text.split(split).filter((record) => record.trim()).slice(0, 200);
      if (!records.length) continue;
      const patterns = {
        time: expression(preset.time, "Time pattern"),
        level: expression(preset.level, "Level pattern"),
        app: expression(preset.app, "App pattern")
      };
      const coverage = (name) => records.filter((record) => patterns[name].test(record)).length / records.length;
      const confidence = coverage("time") * 0.4 + coverage("level") * 0.25 + coverage("app") * 0.35;
      if (!best || confidence > best.confidence) best = { presetId, confidence };
    }
    return best;
  });

  function detect(text) {
    let best = null;
    for (const detector of detectors) {
      const result = detector(text, new Map(presets));
      if (result && presets.has(result.presetId) && Number.isFinite(result.confidence) && (!best || result.confidence > best.confidence)) best = result;
    }
    return best || { presetId: presets.keys().next().value, confidence: 0 };
  }

  function parse(text, patterns) {
    validatePatterns(patterns);
    const split = expression(patterns.split, "Split pattern");
    const extractors = {
      time: expression(patterns.time, "Time pattern"),
      level: expression(patterns.level, "Level pattern"),
      app: expression(patterns.app, "App pattern")
    };
    return text.split(split).filter((record) => record.trim()).map((raw, index) => ({
      index: index + 1,
      raw,
      time: captured(extractors.time, raw),
      level: captured(extractors.level, raw, "UNKNOWN").toUpperCase(),
      app: captured(extractors.app, raw),
      message: raw
    }));
  }

  function createController({ elements, saved, getText, acceptRecords, settingsChanged }) {
    const readPatterns = () => Object.fromEntries(patternNames.map((name) => [name, elements[name].value]));
    const writePatterns = (patterns) => patternNames.forEach((name) => { elements[name].value = patterns[name]; });
    const matchingPreset = (patterns) => [...presets].find(([, preset]) => patternNames.every((name) => patterns[name] === preset[name]))?.[0];
    const syncConfig = () => { elements.config.value = patternNames.map((name) => `${name}=${elements[name].value}`).join("\n"); };

    function setAutomaticState(automatic) {
      elements.fields.disabled = automatic;
      if (!automatic) elements.detection.textContent = "";
    }

    function applyDetection(text) {
      const result = detect(text);
      const preset = presets.get(result.presetId);
      writePatterns(preset);
      const percentage = Math.round(result.confidence * 100);
      elements.detection.textContent = `Detected ${preset.label} (${percentage}% confidence)`;
      syncConfig();
    }

    function parseCurrent(text = getText()) {
      if (elements.preset.value === "auto") applyDetection(text);
      const records = parse(text, readPatterns());
      acceptRecords(records);
      return records;
    }

    function applyPreset() {
      const automatic = elements.preset.value === "auto";
      setAutomaticState(automatic);
      if (!automatic) {
        const preset = presets.get(elements.preset.value);
        if (preset) writePatterns(preset);
        syncConfig();
      }
      elements.error.textContent = "";
      if (getText()) parseCurrent();
      settingsChanged();
    }

    function importConfig() {
      const values = {};
      for (const line of elements.config.value.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const separator = line.indexOf("=");
        if (separator < 1) continue;
        const name = line.slice(0, separator).trim();
        if (patternNames.includes(name)) values[name] = line.slice(separator + 1);
      }
      validatePatterns(values);
      writePatterns(values);
      elements.preset.value = matchingPreset(values) || "custom";
      if (getText()) parseCurrent();
      settingsChanged();
      syncConfig();
    }

    async function copyConfig() {
      syncConfig();
      try { await navigator.clipboard.writeText(elements.config.value); }
      catch { elements.config.select(); document.execCommand("copy"); }
      elements.copyConfig.textContent = "Copied";
      window.setTimeout(() => { elements.copyConfig.textContent = "Copy current"; }, 1200);
    }

    elements.preset.replaceChildren();
    elements.preset.add(new Option("Autodetect", "auto"));
    for (const [id, preset] of presets) elements.preset.add(new Option(preset.label, id));
    elements.preset.add(new Option("Custom", "custom", false, false));
    elements.preset.options[elements.preset.options.length - 1].disabled = true;

    if (saved.patterns) writePatterns(saved.patterns);
    const restoredPreset = matchingPreset(readPatterns());
    elements.preset.value = saved.parserMode || (saved.patterns ? restoredPreset || "custom" : "auto");
    setAutomaticState(elements.preset.value === "auto");
    syncConfig();

    elements.preset.addEventListener("change", applyPreset);
    patternNames.forEach((name) => elements[name].addEventListener("input", () => {
      elements.preset.value = matchingPreset(readPatterns()) || "custom";
    }));
    elements.reparse.addEventListener("click", () => {
      try {
        elements.error.textContent = "";
        parseCurrent();
        settingsChanged();
        syncConfig();
      } catch (error) { elements.error.textContent = error.message; }
    });
    elements.importConfig.addEventListener("click", () => {
      try { elements.error.textContent = ""; importConfig(); }
      catch (error) { elements.error.textContent = error.message; }
    });
    elements.copyConfig.addEventListener("click", copyConfig);

    return {
      parse: parseCurrent,
      getSettings: () => ({ parserMode: elements.preset.value, patterns: readPatterns() })
    };
  }

  window.LogParser = { createController, detect, parse, registerDetector, registerPreset };
}());
