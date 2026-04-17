const DEFAULT_COLORS = ["#03a9f4", "#ff7043", "#66bb6a", "#ab47bc", "#ffa726", "#26c6da"];

const THRESHOLD_PRESETS = {
  none: [],
  temperature_comfort: [
    { value: -50, color: "#42a5f5" },
    { value: 18, color: "#66bb6a" },
    { value: 24, color: "#ffa726" },
    { value: 28, color: "#ef5350" }
  ],
  humidity_comfort: [
    { value: 0, color: "#42a5f5" },
    { value: 35, color: "#66bb6a" },
    { value: 60, color: "#ffa726" },
    { value: 75, color: "#ef5350" }
  ],
  co2_air_quality: [
    { value: 0, color: "#66bb6a" },
    { value: 800, color: "#ffa726" },
    { value: 1200, color: "#ef5350" }
  ]
};

let CHART_JS_LOAD_PROMISE = null;

const escapeHtml = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");

const escapeAttribute = (value) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

const clampInt = (value, fallback, min, max) => {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
};

const parseEntityList = (raw) => {
  if (Array.isArray(raw)) {
    return raw.map((item) => `${item}`.trim()).filter(Boolean);
  }

  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
};

const parseThresholds = (rawThresholds) => {
  if (!Array.isArray(rawThresholds)) return [];

  return rawThresholds
    .map((entry) => {
      if (typeof entry !== "object" || entry === null) return null;
      const value = Number.parseFloat(entry.value);
      const color = `${entry.color || ""}`.trim();
      if (Number.isNaN(value) || !color) return null;
      return { value, color };
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value);
};

const parseThresholdsFromText = (text) =>
  `${text || ""}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [valueRaw, colorRaw] = line.split(",").map((part) => part.trim());
      const value = Number.parseFloat(valueRaw);
      if (Number.isNaN(value) || !colorRaw) return null;
      return { value, color: colorRaw };
    })
    .filter(Boolean)
    .sort((a, b) => a.value - b.value);

const formatThresholdsForText = (thresholds) =>
  (thresholds || []).map((entry) => `${entry.value}, ${entry.color}`).join("\n");

const getPresetThresholds = (preset) => {
  const presetEntries = THRESHOLD_PRESETS[preset] || [];
  return presetEntries.map((entry) => ({ ...entry }));
};

const normalizeConfig = (config) => {
  const entities = parseEntityList(config.entities || config.entity);
  const thresholdPreset = config.threshold_preset || "none";
  const explicitThresholds = parseThresholds(config.thresholds);
  const thresholds = explicitThresholds.length ? explicitThresholds : getPresetThresholds(thresholdPreset);

  return {
    title: "HA Chart Design",
    hours_to_show: clampInt(config.hours_to_show, 24, 1, 24 * 30),
    max_samples: clampInt(config.max_samples, 200, 10, 5000),
    fill: Boolean(config.fill),
    line_width: clampInt(config.line_width, 2, 1, 8),
    colors: Array.isArray(config.colors) ? config.colors.map((c) => `${c}`.trim()).filter(Boolean) : [],
    threshold_preset: thresholdPreset,
    thresholds,
    ...config,
    entities,
    hours_to_show: clampInt(config.hours_to_show, 24, 1, 24 * 30),
    max_samples: clampInt(config.max_samples, 200, 10, 5000),
    fill: Boolean(config.fill),
    line_width: clampInt(config.line_width, 2, 1, 8),
    colors: Array.isArray(config.colors) ? config.colors.map((c) => `${c}`.trim()).filter(Boolean) : [],
    threshold_preset: thresholdPreset,
    thresholds
  };
};

const formatTimestampLabel = (timestampMs) => {
  if (!Number.isFinite(Number(timestampMs))) return "";

  return new Intl.DateTimeFormat(undefined, {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(Number(timestampMs)));
};

const getThresholdColor = (value, thresholds, fallback) => {
  if (!thresholds.length) return fallback;

  let chosen = thresholds[0].color;
  for (const threshold of thresholds) {
    if (value >= threshold.value) {
      chosen = threshold.color;
    }
  }

  return chosen;
};

class HaChartDesignCard extends HTMLElement {
  static getConfigElement() {
    return document.createElement("ha-chart-design-card-editor");
  }

  static getStubConfig() {
    return {
      type: "custom:ha-chart-design-card",
      title: "Climate Overview",
      entities: ["sensor.wohnzimmer_temperatur", "sensor.schlafzimmer_temperatur"],
      threshold_preset: "temperature_comfort",
      hours_to_show: 24,
      max_samples: 200
    };
  }

  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._chart = null;
    this._canvas = null;
    this._updateTimer = null;
    this._updateRequestId = 0;
    this._lastRelevantStateSignature = "";
  }

  setConfig(config) {
    const normalized = normalizeConfig(config || {});

    if (!normalized.entities.length) {
      throw new Error("Configuration error: Please define at least one entity.");
    }

    this._config = normalized;
    this._lastRelevantStateSignature = "";
    this._renderSkeleton();
    this._scheduleUpdate(0);
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;

    const signature = this._getRelevantStateSignature();
    if (signature === this._lastRelevantStateSignature && this._chart) {
      return;
    }

    this._lastRelevantStateSignature = signature;
    this._scheduleUpdate(150);
  }

  disconnectedCallback() {
    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
      this._updateTimer = null;
    }

    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
  }

  getCardSize() {
    return 4;
  }

  _getRelevantStateSignature() {
    if (!this._hass || !this._config?.entities?.length) return "";

    return this._config.entities
      .map((entityId) => {
        const stateObj = this._hass.states?.[entityId];
        if (!stateObj) return `${entityId}|missing`;
        return `${entityId}|${stateObj.state}|${stateObj.last_changed}|${stateObj.last_updated}`;
      })
      .join("||");
  }

  _scheduleUpdate(delay = 0) {
    if (!this._config || !this._hass) return;

    if (this._updateTimer) {
      clearTimeout(this._updateTimer);
    }

    this._updateTimer = setTimeout(() => {
      this._updateTimer = null;
      this._update();
    }, delay);
  }

  async _update() {
    const requestId = ++this._updateRequestId;

    const missing = this._config.entities.filter((entityId) => !this._hass?.states?.[entityId]);
    if (missing.length > 0) {
      if (requestId !== this._updateRequestId) return;
      this._clearChart();
      this._setStatus(`Entity not found: ${missing.join(", ")}`);
      return;
    }

    this._setStatus("Loading history…");

    try {
      const datasets = await this._loadDatasets();

      if (requestId !== this._updateRequestId) return;

      if (!datasets.length) {
        this._clearChart();
        this._setStatus("No numeric history data available for selected entities.");
        return;
      }

      await this._ensureChartJs();

      if (requestId !== this._updateRequestId) return;

      this._setStatus("");
      this._renderChart(datasets);
    } catch (error) {
      if (requestId !== this._updateRequestId) return;
      this._clearChart();
      this._setStatus("Failed to load chart data.");
      // eslint-disable-next-line no-console
      console.error("ha-chart-design-card: update failed", error);
    }
  }

  _clearChart() {
    if (this._chart) {
      this._chart.destroy();
      this._chart = null;
    }
  }

  async _loadDatasets() {
    const entries = await Promise.all(
      this._config.entities.map(async (entityId, index) => {
        const stateObj = this._hass.states[entityId];
        const history = await this._fetchHistory(entityId);

        const points = history
          .map((entry) => {
            const value = Number.parseFloat(entry.state);
            const timestamp = new Date(entry.last_changed).getTime();

            if (Number.isNaN(value) || !Number.isFinite(timestamp)) return null;

            return {
              x: timestamp,
              y: value
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.x - b.x)
          .slice(-this._config.max_samples);

        if (!points.length) return null;

        const baseColor = this._config.colors[index] || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
        const displayName = stateObj.attributes?.friendly_name || entityId;
        const unit = stateObj.attributes?.unit_of_measurement || "";

        return { entityId, displayName, unit, baseColor, points };
      })
    );

    return entries.filter(Boolean);
  }

  async _fetchHistory(entityId) {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - this._config.hours_to_show * 60 * 60 * 1000);

    const path =
      `history/period/${encodeURIComponent(startTime.toISOString())}` +
      `?filter_entity_id=${encodeURIComponent(entityId)}` +
      `&end_time=${encodeURIComponent(endTime.toISOString())}` +
      "&minimal_response";

    try {
      const result = await this._hass.callApi("GET", path);
      return Array.isArray(result?.[0]) ? result[0] : [];
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`ha-chart-design-card: Failed to fetch history for ${entityId}`, err);
      return [];
    }
  }

  async _ensureChartJs() {
    if (window.Chart) return;

    if (!CHART_JS_LOAD_PROMISE) {
      CHART_JS_LOAD_PROMISE = new Promise((resolve, reject) => {
        const existingScript = document.querySelector('script[data-ha-chart-design-chartjs="1"]');

        if (existingScript) {
          existingScript.addEventListener("load", () => resolve(), { once: true });
          existingScript.addEventListener("error", () => reject(new Error("Failed to load Chart.js")), { once: true });
          return;
        }

        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
        script.dataset.haChartDesignChartjs = "1";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Chart.js"));
        document.head.appendChild(script);
      });
    }

    await CHART_JS_LOAD_PROMISE;
  }

  _renderSkeleton() {
    if (!this._config || !this.shadowRoot) return;

    this.shadowRoot.innerHTML = `
      <ha-card header="${escapeAttribute(this._config.title)}">
        <div class="container">
          <div class="chart-wrap">
            <canvas id="chart"></canvas>
          </div>
          <div id="status" class="status"></div>
        </div>
      </ha-card>
      <style>
        :host {
          display: block;
        }

        ha-card {
          background: linear-gradient(145deg, rgba(255, 162, 15, 0.16), rgba(255, 152, 0, 0.06));
          border-radius: 16px;
          overflow: hidden;
        }

        .container {
          padding: 16px;
        }

        .chart-wrap {
          position: relative;
          height: 300px;
          min-height: 300px;
          max-height: 300px;
        }

        canvas {
          display: block;
          width: 100% !important;
          height: 100% !important;
        }

        .status {
          margin-top: 10px;
          color: var(--secondary-text-color);
          font-size: 13px;
          min-height: 18px;
        }
      </style>
    `;

    this._canvas = this.shadowRoot.getElementById("chart");
  }

  _renderChart(seriesList) {
    if (!this._canvas || !window.Chart) return;

    const thresholds = this._config.thresholds;

    const datasets = seriesList.map((series) => ({
      label: series.displayName,
      data: series.points,
      parsing: false,
      borderColor: series.baseColor,
      backgroundColor: this._config.fill ? `${series.baseColor}33` : series.baseColor,
      fill: this._config.fill,
      borderWidth: this._config.line_width,
      pointRadius: 0,
      pointHoverRadius: 3,
      tension: 0.25,
      spanGaps: true,
      segment: thresholds.length
        ? {
            borderColor: (ctx) => {
              const average = (ctx.p0.parsed.y + ctx.p1.parsed.y) / 2;
              return getThresholdColor(average, thresholds, series.baseColor);
            }
          }
        : undefined
    }));

    const options = {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      normalized: true,
      interaction: {
        mode: "nearest",
        intersect: false
      },
      plugins: {
        legend: {
          display: true
        },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items.length) return "";
              return formatTimestampLabel(items[0].parsed.x);
            },
            label: (ctx) => {
              const unit = seriesList[ctx.datasetIndex]?.unit || "";
              return `${ctx.dataset.label}: ${ctx.parsed.y}${unit ? ` ${unit}` : ""}`;
            }
          }
        }
      },
      scales: {
        x: {
          type: "linear",
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            callback: (value) => formatTimestampLabel(value)
          }
        },
        y: {
          ticks: {
            callback: (value) => `${value}`
          }
        }
      }
    };

    if (this._chart) {
      this._chart.data = { datasets };
      this._chart.options = options;
      this._chart.update("none");
      return;
    }

    this._chart = new window.Chart(this._canvas.getContext("2d"), {
      type: "line",
      data: { datasets },
      options
    });
  }

  _setStatus(text) {
    const statusEl = this.shadowRoot?.getElementById("status");
    if (statusEl) {
      statusEl.textContent = text || "";
    }
  }
}

class HaChartDesignCardEditor extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = null;
    this._hass = null;
    this._focusState = null;
    this._scrollState = null;
    this._lastInteractedField = null;
  }

  _configsEqual(leftConfig, rightConfig) {
    if (leftConfig === rightConfig) return true;
    if (!leftConfig || !rightConfig) return false;

    try {
      return JSON.stringify(leftConfig) === JSON.stringify(rightConfig);
    } catch (error) {
      return false;
    }
  }

  _findScrollContainer() {
    let current = this.parentElement;

    while (current) {
      const style = window.getComputedStyle(current);
      const canScroll =
        /(auto|scroll)/.test(style.overflowY || "") && current.scrollHeight > current.clientHeight;

      if (canScroll) {
        return current;
      }

      current = current.parentElement;
    }

    return null;
  }

  _captureScrollState() {
    const container = this._findScrollContainer();
    this._scrollState = container
      ? { type: "element", element: container, top: container.scrollTop }
      : { type: "window", top: window.scrollY };
  }

  _restoreScrollState() {
    if (!this._scrollState) return;

    requestAnimationFrame(() => {
      if (this._scrollState.type === "element" && this._scrollState.element) {
        this._scrollState.element.scrollTop = this._scrollState.top;
        return;
      }

      window.scrollTo({ top: this._scrollState.top, behavior: "auto" });
    });
  }

  _captureFocusState(sourceElement = null) {
    const activeElement =
      sourceElement ||
      this.shadowRoot.querySelector("input:focus, textarea:focus, select:focus");

    if (!activeElement) {
      this._focusState = null;
      return;
    }

    const tagName = activeElement.tagName?.toLowerCase?.() || "";
    const inputType = activeElement.type || "";
    const shouldRestoreFocus =
      tagName === "textarea" ||
      tagName === "select" ||
      (tagName === "input" && inputType !== "checkbox" && inputType !== "radio");

    if (!shouldRestoreFocus) {
      this._focusState = null;
      return;
    }

    this._focusState = {
      selector: `${tagName}[data-key="${activeElement.dataset?.key || ""}"]`,
      selectionStart:
        typeof activeElement.selectionStart === "number" ? activeElement.selectionStart : null,
      selectionEnd:
        typeof activeElement.selectionEnd === "number" ? activeElement.selectionEnd : null
    };
  }

  _restoreFocusState() {
    if (!this._focusState?.selector) return;

    requestAnimationFrame(() => {
      const target = this.shadowRoot.querySelector(this._focusState.selector);
      if (!target) return;

      target.focus();

      if (
        typeof target.setSelectionRange === "function" &&
        this._focusState.selectionStart !== null &&
        this._focusState.selectionEnd !== null
      ) {
        target.setSelectionRange(this._focusState.selectionStart, this._focusState.selectionEnd);
      }
    });
  }

  setConfig(config) {
    const normalized = normalizeConfig(config || {});

    if (this._configsEqual(this._config, normalized)) {
      this._config = normalized;
      return;
    }

    this._captureFocusState(this._lastInteractedField);
    this._captureScrollState();
    this._config = normalized;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this.shadowRoot.innerHTML && this._config) {
      this._render();
    }
  }

  _render() {
    if (!this._config || !this.shadowRoot) return;

    const entitiesText = this._config.entities.join("\n");
    const colorsText = (this._config.colors || []).join(", ");
    const thresholdsText = formatThresholdsForText(this._config.thresholds || []);

    this.shadowRoot.innerHTML = `
      <style>
        .editor {
          display: grid;
          gap: 12px;
          padding: 12px 0;
        }

        label {
          display: grid;
          gap: 6px;
          font-size: 14px;
          color: var(--primary-text-color);
        }

        input, textarea, select {
          font: inherit;
          padding: 8px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
          box-sizing: border-box;
          width: 100%;
        }

        textarea {
          min-height: 68px;
          resize: vertical;
        }

        .hint {
          font-size: 12px;
          color: var(--secondary-text-color);
        }

        .inline {
          display: flex;
          gap: 8px;
          align-items: center;
        }

        .inline input[type="checkbox"] {
          width: auto;
        }
      </style>

      <div class="editor">
        <label>
          Title
          <input data-key="title" value="${escapeAttribute(this._config.title || "")}" />
        </label>

        <label>
          Entities (one per line)
          <textarea data-key="entities">${escapeHtml(entitiesText)}</textarea>
          <div class="hint">Examples: sensor.wohnzimmer_temperatur / sensor.kueche_luftfeuchte</div>
        </label>

        <label>
          Colors by entity (comma separated)
          <input data-key="colors" value="${escapeAttribute(colorsText)}" placeholder="#03a9f4, #ff7043" />
          <div class="hint">Optional. If empty, default palette will be used.</div>
        </label>

        <label>
          Threshold preset
          <select data-key="threshold_preset">
            <option value="none" ${this._config.threshold_preset === "none" ? "selected" : ""}>No preset</option>
            <option value="temperature_comfort" ${this._config.threshold_preset === "temperature_comfort" ? "selected" : ""}>Temperature comfort</option>
            <option value="humidity_comfort" ${this._config.threshold_preset === "humidity_comfort" ? "selected" : ""}>Humidity comfort</option>
            <option value="co2_air_quality" ${this._config.threshold_preset === "co2_air_quality" ? "selected" : ""}>CO₂ air quality</option>
          </select>
        </label>

        <label>
          Threshold colors (one per line: value,color)
          <textarea data-key="thresholds">${escapeHtml(thresholdsText)}</textarea>
          <div class="hint">Manual thresholds override the selected preset.</div>
        </label>

        <label>
          Hours to show
          <input data-key="hours_to_show" type="number" min="1" value="${escapeAttribute(this._config.hours_to_show)}" />
        </label>

        <label>
          Max samples per entity
          <input data-key="max_samples" type="number" min="10" value="${escapeAttribute(this._config.max_samples)}" />
        </label>

        <label>
          Line width
          <input data-key="line_width" type="number" min="1" max="8" value="${escapeAttribute(this._config.line_width)}" />
        </label>

        <label class="inline">
          <input data-key="fill" type="checkbox" ${this._config.fill ? "checked" : ""} />
          Fill area under line
        </label>
      </div>
    `;

    this.shadowRoot.querySelectorAll("input[data-key], textarea[data-key]").forEach((el) => {
      if (el.type === "checkbox") {
        el.addEventListener("change", () => this._valueChanged(el));
      } else {
        el.addEventListener("change", () => this._valueChanged(el));
      }
    });

    this.shadowRoot.querySelectorAll("select[data-key]").forEach((el) => {
      el.addEventListener("change", () => this._valueChanged(el));
    });

    this._restoreScrollState();
    this._restoreFocusState();
  }

  _valueChanged(changedElement) {
    if (!this._config || !this.shadowRoot) return;

    this._lastInteractedField = changedElement;

    const get = (selector) => this.shadowRoot.querySelector(selector);

    const preset = get('[data-key="threshold_preset"]').value;
    const rawThresholds = get('[data-key="thresholds"]').value;
    const parsedManualThresholds = parseThresholdsFromText(rawThresholds);

    const thresholds = parsedManualThresholds.length
      ? parsedManualThresholds
      : getPresetThresholds(preset);

    if (changedElement?.dataset?.key === "threshold_preset" && !parsedManualThresholds.length) {
      get('[data-key="thresholds"]').value = formatThresholdsForText(thresholds);
    }

    const nextConfig = {
      ...this._config,
      title: get('[data-key="title"]').value,
      entities: parseEntityList(get('[data-key="entities"]').value.replace(/\n/g, ",")),
      colors: parseEntityList(get('[data-key="colors"]').value),
      threshold_preset: preset,
      thresholds,
      hours_to_show: clampInt(get('[data-key="hours_to_show"]').value, 24, 1, 24 * 30),
      max_samples: clampInt(get('[data-key="max_samples"]').value, 200, 10, 5000),
      line_width: clampInt(get('[data-key="line_width"]').value, 2, 1, 8),
      fill: get('[data-key="fill"]').checked
    };

    delete nextConfig.entity;

    this._config = normalizeConfig(nextConfig);

    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config: this._config },
        bubbles: true,
        composed: true
      })
    );
  }
}

if (!customElements.get("ha-chart-design-card")) {
  customElements.define("ha-chart-design-card", HaChartDesignCard);
}

if (!customElements.get("ha-chart-design-card-editor")) {
  customElements.define("ha-chart-design-card-editor", HaChartDesignCardEditor);
}

window.customCards = window.customCards || [];

const haChartDesignCardRegistration = {
  type: "custom:ha-chart-design-card",
  name: "HA Chart Design",
  preview: true,
  description: "Line chart card with multi-entity support and threshold color schemes",
  documentationURL: "https://github.com/404GamerNotFound/ha-chart-design"
};

if (!window.customCards.some((entry) => entry.type === haChartDesignCardRegistration.type)) {
  window.customCards.push(haChartDesignCardRegistration);
}
