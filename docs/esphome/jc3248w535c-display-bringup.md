# JC3248W535C — Display bring-up (ESPHome) · Handoff / working notes

> **How to use this doc (for the next session):** read this file first. It
> contains everything already established so we don't re-derive it. The task
> is to get the 3.5" touch screen showing MinerWatch data. The MQTT data path
> already works end-to-end — do **not** redo it.

---

## 1. Goal of this task

Get the touch display on the **Guition JC3248W535C** showing the miner data,
in stages:

1. **Light up the screen** — backlight + display driver + a "hello" label.
   No touch, no LVGL, no MQTT changes. Goal: see *anything* on screen.
2. **Add touch** (verify taps in logs).
3. **LVGL UI** — labels/gauge bound to the sensors that already exist in the
   config (`miner_hashrate`, `miner_power`, `miner_chip_temp`, `miner_status`).
4. Polish.

We isolate the display first because it's the hard, board-specific part
(QSPI + AXS15231B). Expect iteration on pins / init sequence.

---

## 2. Status so far — what ALREADY works (don't redo)

- **Data path MinerWatch → Mosquitto → ESP is proven.** The ESP receives the
  miner values every ~5s. Confirmed in logs:
  `'Miner hashrate' >> 4.9 TH/s`, `'Miner power' >> 95.0 W`,
  `'Miner chip temp' >> 62.0 C`, `'Miner status' >> 'online'`.
- **Device:** name `minerwatch-panel`, ESP32-S3, on WiFi (got IP `192.168.1.18`),
  MQTT broker at `192.168.1.10:1883` (Mosquitto on the Mac, anonymous, test setup).
- **ESPHome:** runs on the Mac via Homebrew. Launch with
  `esphome dashboard ~/esphome` → open `http://localhost:6052`.
  Config file on disk: `~/esphome/minerwatch-panel.yaml`.
  Version ESPHome **2026.5.1**, framework **esp-idf**, first compile ~2 min.
- **Existing sensor IDs to bind to the UI later:**
  `miner_hashrate` (TH/s), `miner_power` (W), `miner_chip_temp` (°C),
  `miner_status` (text: online/offline).
- **Miner topics:** base `minerwatch/e0e1a93f0cbf/f/<field>`,
  availability `minerwatch/e0e1a93f0cbf/availability`.
  (`e0e1a93f0cbf` = the sanitized MAC of the test miner. MinerWatch publishes
  flat topics because `mqtt.publish_flat_topics` is ON.)

### The current working (data-only) config block

This is in `minerwatch-panel.yaml` today (on top of the wizard-generated
wifi/api/ota/logger). **Keep it** — we add display/touch/LVGL around it:

```yaml
mqtt:
  broker: 192.168.1.10

sensor:
  - platform: mqtt_subscribe
    name: "Miner hashrate"
    id: miner_hashrate
    topic: "minerwatch/e0e1a93f0cbf/f/hashrate_ths"
    unit_of_measurement: "TH/s"
  - platform: mqtt_subscribe
    name: "Miner power"
    id: miner_power
    topic: "minerwatch/e0e1a93f0cbf/f/power_w"
    unit_of_measurement: "W"
  - platform: mqtt_subscribe
    name: "Miner chip temp"
    id: miner_temp        # NOTE: id shown as miner_chip_temp in logs; confirm in file
    topic: "minerwatch/e0e1a93f0cbf/f/temp_chip_c"
    unit_of_measurement: "C"

text_sensor:
  - platform: mqtt_subscribe
    name: "Miner status"
    id: miner_status
    topic: "minerwatch/e0e1a93f0cbf/availability"
```

---

## 3. Hardware facts

- **Board:** Guition **JC3248W535C**. MCU **ESP32-S3-WROOM-1**, 240 MHz,
  **8 MB PSRAM (octal)**, **16 MB flash**.
- **Display:** 3.5" IPS, **320×480**, controller **AXS15231B**, **QSPI** interface
  (NOT a normal SPI display).
- **Touch:** capacitive, also **AXS15231B**, over **I2C**.

---

## 4. ⚠️ Key gotcha: the current config has the WRONG flash/PSRAM

The "New device" wizard created the config with board `esp32-s3-devkitc-1`.
Boot log shows **"SPI Flash Size : 4MB"** and **PSRAM not enabled**. That was
fine for the data-only test, but the display needs more:

- **PSRAM is required** for the framebuffer (320×480×2 ≈ 300 KB). Must add a
  `psram:` block (octal) and make sure the board/variant exposes it.
- **Flash size** should be 16 MB. Set `esp32: flash_size: 16MB` (or a matching
  board) so we're not capped at 4 MB.

So the first edit for the screen stage includes fixing `esp32:` + adding `psram:`.

---

## 5. Pin map / driver (from known-good configs — VERIFY against reference)

- **PSRAM:** `mode: octal`, `speed: 80MHz`
- **QSPI bus:** `type: quad`, `clk_pin: 10`, `data_pins: [11, 12, 13, 14]`
- **Display:** `platform: mipi_spi` (or `qspi_dbi`, depends on ESPHome version),
  `model: AXS15231`, `cs_pin: 9`, `reset_pin: 21`, dimensions 320×480
- **Backlight:** likely **GPIO1**, PWM via LEDC, must be turned ON
  (black screen if off) — verify
- **Touch:** `platform: axs15231`, I2C `sda: 4`, `scl: 8`

These are consistent across the community configs but the exact component name
(`mipi_spi` vs `qspi_dbi`) and any `init_sequence` are version-sensitive — lift
them verbatim from the reference below rather than hand-rolling.

---

## 6. Reference configs (start here, don't hand-roll the display block)

- **`clowrey/ESPhome-JC3248W535EN`** (GitHub) — example ESPHome config for this
  exact board. Best starting point.
- HA community threads:
  - "JC3248W535 (Guition 3.5") Config"
  - "jc3248w535 display — qspi_dbi / axs15231"
- ESPHome docs: **Quad SPI (`qspi_dbi`)**, **MIPI SPI (`mipi_spi`)** display
  components, and the **LVGL** component.

---

## 7. Build order (do these in order, test each)

1. **Light up the screen (no MQTT, no touch):** fix `esp32:` flash size, add
   `psram:`, `spi:` (quad), `display:` (AXS15231) + `light:`/`output:` for the
   backlight, and a temporary `lambda:` that prints "hello". Install → Logs.
   Goal: ANY pixels on screen.
   - Black-screen suspects, in order: backlight pin not driven; PSRAM missing;
     wrong component/model; wrong init sequence; wrong rotation.
2. **Touch:** add `i2c:` + `touchscreen: axs15231`; tap and confirm coordinates
   appear in the logs.
3. **LVGL UI:** replace the lambda with an `lvgl:` screen — labels/gauge reading
   `id(miner_hashrate).state`, `id(miner_power).state`, `id(miner_temp).state`,
   and `id(miner_status).state`. These IDs already exist (section 2).
4. **Polish:** layout, colours, maybe a second screen, units.

---

## 8. How to operate ESPHome (recap)

- Launch dashboard (Mac, leave terminal open): `esphome dashboard ~/esphome`
  → `http://localhost:6052`.
- **Edit** config: device card → **EDIT**.
- **Install:** card → **INSTALL** → **Wirelessly** (OTA works now that the
  device runs this config) or **Plug into this computer** (USB).
- **Logs:** card → **LOGS** (runtime). Compile errors show in the INSTALL console.
- First-ever compile downloads the ESP32 toolchain (~2 min); the earlier
  "Unable to compile" was just that download, not a config error.

---

## 9. MinerWatch side (context only — NOT part of this task)

The MQTT publisher feature (what feeds these topics) lives on git branch
**`feat/mqtt-ha`** in the MinerWatch repo: `backend/mqtt.py`, `MqttCfg` in
`backend/config.py`, the Settings **MQTT** tab, `mqtt.publish_flat_topics`.
Design + topic schema: `docs/home-assistant-integration.md`. Not yet committed.
For the screen work you only need the broker running and the topics in §2.
```
