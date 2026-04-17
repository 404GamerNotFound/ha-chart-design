# HA Chart Design (HACS)

Eine Home Assistant Lovelace-Karte für Liniencharts (z. B. Temperaturcharts) mit Mehrfach-Entitäten, UI-Editor und Threshold-Farbschemata.

## Features

- Anzeige von einer oder mehreren Sensor-Historien als Linienchart
- Visueller Lovelace UI-Editor für die Konfiguration
- Farbschema pro Entität oder automatisch aus Palette
- Threshold-basierte Verfärbung der Liniensegmente
- Threshold-Presets für Temperatur, Luftfeuchtigkeit und CO₂
- Zeitfenster, Liniendicke, Fill und Sample-Limit einstellbar

## Installation (HACS)

1. Repository als **Custom Repository** in HACS hinzufügen:
   - `https://github.com/404GamerNotFound/ha-chart-design`
2. Typ: **Dashboard**
3. Plugin installieren
4. Home Assistant neu laden

## Ressource einbinden

Falls HACS die Ressource nicht automatisch anlegt:

- URL: `/hacsfiles/ha-chart-design/ha-chart-design-card.js`
- Typ: `module`

## Beispiel-Konfiguration

```yaml
type: custom:ha-chart-design-card
title: Klima Überblick
entities:
  - sensor.wohnzimmer_temperatur
  - sensor.schlafzimmer_temperatur
hours_to_show: 24
max_samples: 250
line_width: 2
fill: false
colors:
  - '#03a9f4'
  - '#ff7043'
threshold_preset: temperature_comfort
thresholds:
  - value: 18
    color: '#42a5f5'
  - value: 24
    color: '#66bb6a'
  - value: 28
    color: '#ef5350'
```

## UI-Editor

Im Lovelace-Karteneditor können folgende Felder direkt gepflegt werden:

- Titel
- Entitäten (eine pro Zeile)
- Farben je Entität (kommagetrennt)
- Threshold-Preset auswählen
- Thresholds (`value,color`, eine Zeile pro Threshold)
- `hours_to_show`, `max_samples`, `line_width`, `fill`

## Optionen

- `title` (string, default: `HA Chart Design`)
- `entities` (array[string], mindestens eine Entität)
- `colors` (array[string], optional)
- `threshold_preset` (string, default: `none`)
  - `none`
  - `temperature_comfort`
  - `humidity_comfort`
  - `co2_air_quality`
- `thresholds` (array[object], optional, überschreibt Preset)
  - `value` (number)
  - `color` (string)
- `hours_to_show` (number, default: `24`)
- `max_samples` (number, default: `200`)
- `line_width` (number, default: `2`)
- `fill` (boolean, default: `false`)

## Verwandte Projekte

- Button design: https://github.com/404GamerNotFound/ha-button-design
- Heat design: https://github.com/404GamerNotFound/ha-heat-design
- Slider design: https://github.com/404GamerNotFound/ha-slider-design

## Hinweis

Die Karte erwartet numerische Historienwerte. Für reine Text-States ist keine Diagramm-Darstellung möglich.
