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

const parseThresholdsFromText = (text) => `${text || ""}`
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

const formatThresholdsForText = (thresholds) => thresholds.map((entry) => `${entry.value}, ${entry.color}`).join("\n");

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
    hours_to_show: 24,
    max_samples: 200,
    fill: false,
    line_width: 2,
    colors: [],
    threshold_preset: "none",
    thresholds: [],
    ...config,
    entities,
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
    this._chartPromise = null;
    this._canvas = null;
  }

  setConfig(config) {
    const normalized = normalizeConfig(config || {});

    if (!normalized.entities.length) {
      throw new Error("Configuration error: Please define at least one entity.");
    }

    this._config = normalized;
    this._renderSkeleton();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    this._update();
  }

  getCardSize() {
    return 4;
  }

  async _update() {
    const missing = this._config.entities.filter((entityId) => !this._hass?.states?.[entityId]);
    if (missing.length > 0) {
      this._setStatus(`Entity not found: ${missing.join(", ")}`);
      return;
    }

    const datasets = await this._loadDatasets();
    if (!datasets.length) {
      this._setStatus("No numeric history data available for selected entities.");
      return;
    }

    this._setStatus("");
    await this._ensureChartJs();
    this._renderChart(datasets);
  }

  async _loadDatasets() {
    const entries = await Promise.all(
      this._config.entities.map(async (entityId, index) => {
        const stateObj = this._hass.states[entityId];
        const history = await this._fetchHistory(entityId);
        const points = history
          .map((entry) => {
            const value = Number.parseFloat(entry.state);
            if (Number.isNaN(value)) return null;
            return {
              x: new Date(entry.last_changed).getTime(),
              y: value
            };
          })
          .filter(Boolean)
          .slice(-this._config.max_samples);

        if (!points.length) return null;

        const baseColor = this._config.colors[index] || DEFAULT_COLORS[index % DEFAULT_COLORS.length];
        const displayName = stateObj.attributes.friendly_name || entityId;
        const unit = stateObj.attributes.unit_of_measurement || "";

        return { entityId, displayName, unit, baseColor, points };
      })
    );

    return entries.filter(Boolean);
  }

  async _fetchHistory(entityId) {
    const endTime = new Date();
    const startTime = new Date(endTime.getTime() - this._config.hours_to_show * 60 * 60 * 1000);

    const path = `history/period/${encodeURIComponent(startTime.toISOString())}` +
      `?filter_entity_id=${encodeURIComponent(entityId)}` +
      `&end_time=${encodeURIComponent(endTime.toISOString())}` +
      "&minimal_response";

    try {
      const result = await this._hass.callApi("GET", path);
      return Array.isArray(result?.[0]) ? result[0] : [];
    } catch (err) {
      // Keep detailed fetch errors in console for easier debugging.
      // eslint-disable-next-line no-console
      console.error(`ha-chart-design-card: Failed to fetch history for ${entityId}`, err);
      return [];
    }
  }

  async _ensureChartJs() {
    if (window.Chart) return;

    if (!this._chartPromise) {
      this._chartPromise = new Promise((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/chart.js@4.4.3/dist/chart.umd.min.js";
        script.onload = () => resolve();
        script.onerror = () => reject(new Error("Failed to load Chart.js"));
        document.head.appendChild(script);
      });
    }

    await this._chartPromise;
  }

  _renderSkeleton() {
    this.shadowRoot.innerHTML = `
      <ha-card header="${this._config.title}">
        <div class="container">
          <canvas id="chart"></canvas>
          <div id="status" class="status"></div>
        </div>
      </ha-card>
      <style>
        ha-card {
          background: linear-gradient(145deg, rgba(255, 162, 15, 0.16), rgba(255, 152, 0, 0.06));
          border-radius: 16px;
        }

        .container {
          padding: 16px;
          position: relative;
          min-height: 300px;
        }

        canvas {
          width: 100%;
          height: 280px;
        }

        .status {
          margin-top: 10px;
          color: var(--secondary-text-color);
          font-size: 13px;
        }
      </style>
    `;

    this._canvas = this.shadowRoot.getElementById("chart");
  }

  _renderChart(seriesList) {
    const thresholds = this._config.thresholds;

    const datasets = seriesList.map((series) => ({
      label: series.displayName,
      data: series.points,
      parsing: false,
      borderColor: series.baseColor,
      backgroundColor: this._config.fill ? `${series.baseColor}44` : series.baseColor,
      fill: this._config.fill,
      borderWidth: this._config.line_width,
      pointRadius: 0,
      tension: 0.25,
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
      scales: {
        x: {
          type: "linear",
          ticks: {
            maxRotation: 0,
            autoSkip: true,
            maxTicksLimit: 8,
            callback: (value) => formatTimestampLabel(value)
          }
        }
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
      }
    };

    if (this._chart) {
      this._chart.destroy();
    }

    this._chart = new window.Chart(this._canvas, { type: "line", data: { datasets }, options });
  }

  _setStatus(text) {
    const statusEl = this.shadowRoot?.getElementById("status");
    if (statusEl) {
      statusEl.textContent = text;
    }
  }
}

class HaChartDesignCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = normalizeConfig(config || {});
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _render() {
    if (!this.shadowRoot) {
      this.attachShadow({ mode: "open" });
    }

    if (!this._config) {
      return;
    }

    const entitiesText = this._config.entities.join("\n");
    const colorsText = (this._config.colors || []).join(", ");
    const thresholdsText = formatThresholdsForText(this._config.thresholds || []);

    this.shadowRoot.innerHTML = `
      <style>
        .editor { display: grid; gap: 12px; padding: 12px 0; }
        label { display: grid; gap: 6px; font-size: 14px; color: var(--primary-text-color); }
        input, textarea, select {
          font: inherit;
          padding: 8px;
          border: 1px solid var(--divider-color);
          border-radius: 8px;
          background: var(--card-background-color);
          color: var(--primary-text-color);
        }
        textarea { min-height: 68px; resize: vertical; }
        .hint { font-size: 12px; color: var(--secondary-text-color); }
        .inline { display: flex; gap: 8px; align-items: center; }
      </style>
      <div class="editor">
        <label>
          Title
          <input data-key="title" value="${this._config.title || ""}" />
        </label>

        <label>
          Entities (one per line)
          <textarea data-key="entities">${entitiesText}</textarea>
          <div class="hint">Examples: sensor.wohnzimmer_temperatur / sensor.kueche_luftfeuchte</div>
        </label>

        <label>
          Colors by entity (comma separated)
          <input data-key="colors" value="${colorsText}" placeholder="#03a9f4, #ff7043" />
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
          <textarea data-key="thresholds">${thresholdsText}</textarea>
          <div class="hint">Manual thresholds override the selected preset.</div>
        </label>

        <label>
          Hours to show
          <input data-key="hours_to_show" type="number" min="1" value="${this._config.hours_to_show}" />
        </label>

        <label>
          Max samples per entity
          <input data-key="max_samples" type="number" min="10" value="${this._config.max_samples}" />
        </label>

        <label>
          Line width
          <input data-key="line_width" type="number" min="1" max="8" value="${this._config.line_width}" />
        </label>

        <label class="inline">
          <input data-key="fill" type="checkbox" ${this._config.fill ? "checked" : ""} />
          Fill area under line
        </label>
      </div>
    `;

    this.shadowRoot.querySelectorAll("input, textarea, select").forEach((el) => {
      const eventName = el.tagName === "SELECT" || el.type === "checkbox" ? "change" : "input";
      el.addEventListener(eventName, () => this._valueChanged(el));
    });
  }

  _valueChanged(changedElement) {
    const get = (selector) => this.shadowRoot.querySelector(selector);

    const preset = get('[data-key="threshold_preset"]').value;
    const rawThresholds = get('[data-key="thresholds"]').value;
    const parsedManualThresholds = parseThresholdsFromText(rawThresholds);

    const thresholds = parsedManualThresholds.length ? parsedManualThresholds : getPresetThresholds(preset);

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
      hours_to_show: Number.parseInt(get('[data-key="hours_to_show"]').value, 10) || 24,
      max_samples: Number.parseInt(get('[data-key="max_samples"]').value, 10) || 200,
      line_width: Number.parseInt(get('[data-key="line_width"]').value, 10) || 2,
      fill: get('[data-key="fill"]').checked
    };

    delete nextConfig.entity;

    this._config = normalizeConfig(nextConfig);

    this.dispatchEvent(new CustomEvent("config-changed", {
      detail: { config: this._config },
      bubbles: true,
      composed: true
    }));
  }
}

customElements.define("ha-chart-design-card", HaChartDesignCard);
customElements.define("ha-chart-design-card-editor", HaChartDesignCardEditor);

window.customCards = window.customCards || [];
window.customCards.push({
  type: "ha-chart-design-card",
  name: "HA Chart Design",
  preview: true,
  description: "Line chart card with multi-entity support and threshold color schemes",
  documentationURL: "https://github.com/404GamerNotFound/ha-chart-design"
});
