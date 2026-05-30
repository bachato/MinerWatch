# Home Assistant Integration — Design Doc

> Status: **proposal / not implemented.** This document is the reference
> for *if/when* we build the Home Assistant (HA) integration. It captures
> the concepts, the chosen architecture, the full MQTT topic + payload
> schemas, the entity mapping for our real data model, and an
> implementation checklist. No code has been written yet.
>
> Companion docs: [`guardian-design.md`](guardian-design.md),
> [`donate-hashrate-design.md`](donate-hashrate-design.md). Security
> implications are cross-referenced in [`../security-review.md`](../security-review.md).

---

## 1. Goal

Make every miner MinerWatch already polls appear automatically as a
**device with entities** inside Home Assistant, so users can:

- put hashrate / temp / power next to the rest of their smart home;
- write automations on miner data (tariff-aware mining, solar-surplus
  mining, heat reuse, offline alerts);
- optionally **control** miners (fan, restart, frequency) from HA.

MinerWatch stays the brain (monitoring + optimization); HA becomes a
*consumer* (and optionally a *controller*) of the data we already have.

The integration must be **zero-config after setup**: the user enters
broker details once, and all current + future miners show up on their own.

---

## 2. Primer (concepts in one place)

- **Home Assistant (HA):** self-hosted home-automation hub. Runs on the
  same kind of box as MinerWatch (Pi / mini-PC). Models everything as
  *entities* (a sensor, a switch, a number…).
- **MQTT:** lightweight publish/subscribe messaging protocol. Nobody talks
  directly; everyone goes through a **broker**.
- **Broker:** the message post-office. In HA-land this is almost always the
  **Mosquitto** add-on (one-click install). MinerWatch connects to it as a
  client and *publishes*; HA is another client that *subscribes*.
- **Topic:** the address a message is published to, e.g.
  `minerwatch/aabbccddeeff/state`.
- **Retained message:** the broker keeps the *last* message on a topic and
  delivers it immediately to any new subscriber. We use this so HA has data
  the instant it (re)connects, without waiting for the next poll.
- **LWT (Last Will & Testament):** a message the broker publishes *on our
  behalf* if we disconnect uncleanly. We use it to flip MinerWatch to
  "offline" automatically.
- **MQTT Discovery:** the mechanism that makes this plug-and-play. We
  publish a small JSON *config* message describing an entity; HA reads it
  and **creates the entity automatically**. No YAML editing by the user.

---

## 3. Architecture & data flow

```
  ┌────────────┐   poll (existing, 5s)   ┌─────────────┐
  │  Miners    │◀───────────────────────▶│  MinerWatch │
  │ (Bitaxe…)  │                          │   poller    │
  └────────────┘                          └──────┬──────┘
                                                  │ NEW: publish
                                                  ▼
                                          ┌─────────────┐
                                          │  MQTT       │
                                          │  publisher  │  (new backend/mqtt.py)
                                          └──────┬──────┘
                                                 │ TCP (LAN)
                                                 ▼
                                          ┌─────────────┐
                                          │   Broker    │  (Mosquitto add-on)
                                          │ (Mosquitto) │
                                          └──────┬──────┘
                                                 │ subscribe
                                                 ▼
                                          ┌─────────────┐
                                          │    Home     │  auto-creates devices
                                          │  Assistant  │  + entities via Discovery
                                          └─────────────┘
```

Key point: the integration **reuses the existing poll cycle**. After each
poll, the publisher pushes one state message per miner. It is an additive
*sink* on data we already collect — not a new subsystem.

---

## 4. Design decisions

### 4.1 MQTT Discovery (chosen) vs custom HA integration

| | MQTT Discovery (push from MinerWatch) | Custom HA integration (pull) |
|---|---|---|
| Where code lives | Our repo (`backend/mqtt.py`) | Separate repo, distributed via HACS |
| Maintenance | Our release cycle | Tracks HA's changing APIs |
| User setup | Install Mosquitto, paste broker creds | Install from HACS, point at API |
| Reuses | Existing poller + data model | Our REST API |
| Reach | Anything MQTT (Node-RED, etc.), not just HA | HA only |

**Decision: MQTT Discovery first.** It keeps the work in our codebase and
release cycle, reuses the poller, and benefits the whole MQTT ecosystem. A
native HACS integration can come later as a "v2" for users who don't want a
broker.

### 4.2 One JSON state topic per miner (not one topic per metric)

Publish a **single retained JSON blob** per miner to
`minerwatch/<mac>/state`, and have each entity's discovery config extract
its field with a `value_template`. ~20 entities → **1** publish per poll
instead of 20. Lower broker traffic, atomic snapshots, simpler code.

This is ideal for HA (which parses JSON with `value_template` natively).
Constrained consumers that can't easily parse JSON on-device — notably an
**ESP32/ESPHome panel** — are better served by *flat* per-field topics. We
support both via an opt-in flag; see **§11 (ESP32 / ESPHome touch panel)**.

### 4.3 Stable identity = MAC

The `miners` table already has `mac TEXT UNIQUE` as the stable key "in case
the IP changes". We reuse it for HA `unique_id` / device `identifiers`, so
an entity survives IP changes, renames, and re-discovery. Sanitize for
topic/identifier use: `mac_id = mac.replace(":", "").lower()`.

### 4.4 Read-only by default; controls are opt-in

Sensors ship first and are always safe. **Command** entities (restart, fan,
frequency, voltage) are gated behind (a) the driver capability flags and
(b) a global config toggle `mqtt.allow_controls` that defaults to **false**.
Frequency/voltage writes can damage hardware and interact with Guardian /
auto-fan — see §8.

---

## 5. Topic structure

Two prefixes, both configurable:

- **Discovery prefix** (HA default): `homeassistant`
- **State/command prefix** (ours): `minerwatch`

```
# Bridge device (MinerWatch itself)
minerwatch/bridge/availability                 → "online" | "offline" (LWT)

# Per-miner
minerwatch/<mac>/state                         → retained JSON, all metrics (for HA)
minerwatch/<mac>/availability                  → "online" | "offline" (per-miner, from poller)

# Optional FLAT per-field topics (mqtt.publish_flat_topics = true) — for ESP32/ESPHome
minerwatch/<mac>/f/hashrate_ths                → "1.21"   (retained scalar)
minerwatch/<mac>/f/temp_chip_c                 → "62.5"
minerwatch/<mac>/f/power_w                     → "18.4"
minerwatch/<mac>/f/fan_pct                     → "75"     (… one topic per field in §6.5)

# Per-miner commands (only when mqtt.allow_controls = true AND capability flag set)
minerwatch/<mac>/cmd/restart                   → "RESTART"
minerwatch/<mac>/cmd/fan                        → 0..100        (can_set_fan)
minerwatch/<mac>/cmd/fan_mode                   → manual|firmware|minerwatch
minerwatch/<mac>/cmd/frequency                  → MHz integer   (can_set_frequency)
minerwatch/<mac>/cmd/voltage                    → mV integer    (can_set_voltage)

# Discovery (one per entity)
homeassistant/<component>/minerwatch_<mac>/<object_id>/config
   e.g. homeassistant/sensor/minerwatch_aabbccddeeff/hashrate/config
```

`<component>` ∈ `sensor | binary_sensor | button | number | select`.

---

## 6. Discovery payloads

### 6.1 Shared `device` block (groups all entities under one device)

Every entity's config embeds the same device block so HA collapses them into
one device card:

```json
"device": {
  "identifiers": ["minerwatch_aabbccddeeff"],
  "name": "Bitaxe Denver",
  "manufacturer": "MinerWatch",
  "model": "Bitaxe Supra · BM1368",
  "sw_version": "AxeOS 2.4.0",
  "configuration_url": "http://minerwatch.local:8000/miners/3",
  "via_device": "minerwatch_bridge"
}
```

`via_device` links each miner under the MinerWatch "bridge" device, mirroring
how a hub exposes child devices.

### 6.2 Example — hashrate sensor

Topic: `homeassistant/sensor/minerwatch_aabbccddeeff/hashrate/config`
(retained)

```json
{
  "name": "Hashrate",
  "unique_id": "minerwatch_aabbccddeeff_hashrate",
  "state_topic": "minerwatch/aabbccddeeff/state",
  "value_template": "{{ value_json.hashrate_ths }}",
  "unit_of_measurement": "TH/s",
  "state_class": "measurement",
  "icon": "mdi:pickaxe",
  "availability": [
    { "topic": "minerwatch/bridge/availability" },
    { "topic": "minerwatch/aabbccddeeff/availability" }
  ],
  "availability_mode": "all",
  "device": { "...": "shared block from 6.1" },
  "origin": { "name": "MinerWatch", "sw_version": "1.9.1",
              "support_url": "https://github.com/imlenti/MinerWatch" }
}
```

The `~` abbreviation can shorten payloads (set `"~": "minerwatch/<mac>"`,
then `"state_topic": "~/state"`); kept explicit here for clarity.

### 6.3 Example — restart button (capability-gated)

Topic: `homeassistant/button/minerwatch_aabbccddeeff/restart/config`

```json
{
  "name": "Restart",
  "unique_id": "minerwatch_aabbccddeeff_restart",
  "command_topic": "minerwatch/aabbccddeeff/cmd/restart",
  "payload_press": "RESTART",
  "device_class": "restart",
  "entity_category": "config",
  "availability": [{ "topic": "minerwatch/bridge/availability" }],
  "device": { "...": "shared block" }
}
```

### 6.4 Example — fan-speed control (number)

Topic: `homeassistant/number/minerwatch_aabbccddeeff/fan/config`

```json
{
  "name": "Fan speed",
  "unique_id": "minerwatch_aabbccddeeff_fan",
  "command_topic": "minerwatch/aabbccddeeff/cmd/fan",
  "state_topic": "minerwatch/aabbccddeeff/state",
  "value_template": "{{ value_json.fan_pct }}",
  "min": 0, "max": 100, "step": 1,
  "unit_of_measurement": "%",
  "icon": "mdi:fan",
  "entity_category": "config",
  "device": { "...": "shared block" }
}
```

### 6.5 Example — state JSON payload (published to `minerwatch/<mac>/state`)

```json
{
  "hashrate_ths": 1.21,
  "power_w": 18.4,
  "efficiency_w_per_ths": 15.2,
  "temp_chip_c": 62.5,
  "temp_chip_2_c": null,
  "temp_vr_c": 58.0,
  "fan_rpm": 4200,
  "fan_pct": 75,
  "frequency_mhz": 525,
  "voltage_mv": 1200,
  "current_a": null,
  "hw_errors": 3,
  "hw_error_rate": 0.02,
  "uptime_s": 84213,
  "accepted": 10432,
  "rejected": 7,
  "best_difficulty": 4290000000,
  "best_difficulty_alltime": 9120000000,
  "network_difficulty": 121500000000000,
  "pool_url": "stratum+tcp://public-pool.io:21496",
  "worker": "bc1q...denver",
  "pool_active": "primary",
  "fan_mode": "minerwatch",
  "status": "online"
}
```

---

## 7. Entity map (grounded in `backend/miners/base.py` `MinerSample`)

Sensors. `device_class` left blank where HA has none for the quantity.

| Field (`MinerSample`) | HA component | device_class | unit | state_class | notes |
|---|---|---|---|---|---|
| `hashrate_ths` | sensor | — | TH/s | measurement | icon `mdi:pickaxe` |
| `power_w` | sensor | power | W | measurement | |
| `efficiency_w_per_ths` | sensor | — | W/TH | measurement | the "is it worth it" metric |
| `temp_chip_c` | sensor | temperature | °C | measurement | hottest chip sensor |
| `temp_chip_2_c` | sensor | temperature | °C | measurement | multi-ASIC only; skip if null |
| `temp_vr_c` | sensor | temperature | °C | measurement | VR temp |
| `temp_outlet_c` / `temp_inlet_c` / `temp_avg_c` | sensor | temperature | °C | measurement | Avalon/Canaan |
| `fan_rpm` (+ `fan_rpm_2`) | sensor | — | rpm | measurement | icon `mdi:fan` |
| `fan_pct` (+ `fan_pct_2`) | sensor | — | % | measurement | also a *number* if controllable |
| `frequency_mhz` | sensor | frequency | MHz | measurement | also *number* if `can_set_frequency` |
| `voltage_mv` | sensor | voltage | mV | measurement | also *number* if `can_set_voltage` |
| `current_a` | sensor | current | A | measurement | NerdOctaxe etc. |
| `chip_count` / `board_count` | sensor | — | — | measurement | diagnostic |
| `hw_errors` | sensor | — | — | total_increasing | diagnostic |
| `hw_error_rate` | sensor | — | % | measurement | diagnostic |
| `uptime_s` | sensor | duration | s | — | |
| `accepted` | sensor | — | shares | total_increasing | icon `mdi:check` |
| `rejected` | sensor | — | shares | total_increasing | icon `mdi:close` |
| `best_difficulty` | sensor | — | — | measurement | icon `mdi:trophy` |
| `best_difficulty_alltime` | sensor | — | — | measurement | all-time best |
| `network_difficulty` | sensor | — | — | measurement | for find-block math |
| `pool_url` / `worker` / `pool_active` | sensor | — | — | — | `entity_category: diagnostic` |
| `firmware_version` / `model` / `chip_model` / `mac` | — | — | — | — | put in `device` block, not as entities |
| `status` (online/offline) | binary_sensor | connectivity | — | — | `payload_on:"online"` / `payload_off:"offline"` |

Controls (only if `mqtt.allow_controls = true` **and** the flag is set):

| Capability flag | HA component | command topic | range / payload |
|---|---|---|---|
| `can_restart` | button | `cmd/restart` | `RESTART` |
| `can_set_fan` | number | `cmd/fan` | 0–100 % |
| (fan strategy) | select | `cmd/fan_mode` | `manual` / `firmware` / `minerwatch` |
| `can_set_frequency` | number | `cmd/frequency` | min/max from miner's allowed list, MHz |
| `can_set_voltage` | number | `cmd/voltage` | mV (tight bounds — see §8) |
| `can_set_pool` | — | — | **out of scope v1** (complex, donate-flow owns it) |

Capability flags per family (`backend/miners/*.py`): Bitaxe/NerdOctaxe
expose fan + frequency + restart; LuxOS/Braiins/Canaan vary — drive the
control entities off the live flags, never hardcode per family.

---

## 8. Edge cases & gotchas

- **Retain discovery configs (`retain=true`).** Otherwise HA loses all
  entities on its next restart until our next publish. State messages:
  retain too, so HA has a value immediately on reconnect.
- **Frequency/voltage are dangerous.** Overclock/undervolt can brick or
  destabilize a miner, and they **fight Guardian and auto-fan** (a server
  PID may immediately override an HA-set value). Default `allow_controls`
  off. When on: clamp to the miner's advertised min/max, and document that
  Guardian/auto-fan take precedence (or auto-switch `fan_mode` to `manual`
  when HA sets a fan value).
- **Lifecycle = discovery lifecycle.** On miner *added* → publish configs.
  On miner *removed* → publish an **empty** retained payload to each config
  topic to delete the entity from HA. On *rename* → re-publish `device.name`.
- **Bridge availability via LWT.** On connect publish
  `minerwatch/bridge/availability = online` (retained); register LWT
  `= offline`. Per-miner availability is driven by the poller's
  online/offline/error status, not by the MQTT socket.
- **Null fields.** Don't emit entities for fields that are always null on a
  given miner (e.g. `current_a` on Bitaxe). Decide at discovery time from
  the first successful poll, or publish the full set and let HA show
  "unavailable" — prefer the former to avoid dead entities.
- **Units HA accepts:** frequency `device_class` accepts MHz; voltage
  accepts mV; duration accepts s. `W/TH`, `TH/s`, `rpm`, `shares` have no
  device_class — use a custom `unit_of_measurement` + `state_class`.
- **MAC missing.** A few drivers may not report a MAC. Fall back to a stable
  synthetic id (e.g. `mw<db_id>`) but prefer MAC when present.
- **QoS.** QoS 0 is fine for high-frequency state (next poll corrects any
  drop). Use QoS 1 for discovery configs and commands.

---

## 9. Configuration surface (new `mqtt` section)

Add to `config.example.yaml` / `MqttCfg` in `backend/config.py`, editable
from a new **Settings → MQTT / Home Assistant** tab:

```yaml
mqtt:
  enabled: false
  host: ""                 # e.g. localhost (or the Mosquitto add-on's IP)
  port: 1883
  username: ""
  password: ""             # see security note below
  base_topic: "minerwatch"
  discovery_prefix: "homeassistant"
  qos: 1
  retain: true
  allow_controls: false    # expose write/command entities to HA
  publish_interval_s: 0    # 0 = publish on every poll; >0 = throttle
  publish_flat_topics: false  # also publish minerwatch/<mac>/f/<field> scalars (ESP32/ESPHome)
```

---

## 10. Implementation checklist

1. **Add dependency:** an async MQTT client — `aiomqtt` (wraps paho,
   asyncio-native). Pin it in `requirements.txt`.
2. **New module `backend/mqtt.py`:** connection mgmt (reconnect/backoff),
   LWT, `publish_discovery(miner)`, `publish_state(miner, sample)`,
   `remove_discovery(miner)`, command subscriptions → dispatch to driver
   methods (`set_fan_speed`, `set_frequency`, `set_voltage`, `restart`).
3. **Hook the poller:** after each successful poll, call
   `mqtt.publish_state(...)`. Reuse `MinerSample.to_db_sample()` shape +
   the extra fields in §6.5.
4. **Lifecycle hooks:** on miner add/remove/rename call discovery
   publish/remove. On startup publish discovery for all enabled miners.
5. **Startup/shutdown:** start the client in `on_startup` (after `db.init_db`),
   stop cleanly in `on_shutdown` (publish bridge `offline`). Self-disable
   gracefully if `mqtt.enabled` is false or the lib is missing — mirror the
   `log_streamer` pattern that "self-disables if `websockets` is missing".
6. **Settings tab + API:** `MqttCfg`, override plumbing
   (`cfg.apply_overrides`), and a "Test connection" button.
7. **Capability-driven controls:** build command entities only from live
   `can_*` flags AND `allow_controls`.
8. **Docs:** user setup guide (install Mosquitto, paste creds), screenshot.
9. **(Optional) Flat topics:** when `publish_flat_topics` is on, also emit
   `minerwatch/<mac>/f/<field>` scalars in `publish_state(...)`. Cheap add-on
   that unlocks the ESPHome panel (§11) without on-device JSON parsing.

---

## 11. ESP32 / ESPHome touch panel (candidate first milestone)

> This is the path most likely to be implemented first: a small ESP32-S3
> touch screen acting as a **physical dashboard / remote** for the miners.

### 11.1 Can the panel run Home Assistant? No — use ESPHome.

HA is a Python app that needs Linux, GBs of RAM/storage and a database; an
ESP32-S3 is a microcontroller (KBs of SRAM, a few MB of flash). HA cannot
run on it — *not a version limitation, a hardware-class one.*

The right tool is **ESPHome**: a firmware framework purpose-built for
ESP32, with a native HA API **and** a built-in `mqtt` component, plus
**LVGL** for touch UIs. Modern touch boards (e.g. Waveshare
ESP32-S3-Touch-LCD-4/7, generic 480×480 panels) are documented ESPHome
targets (needs ESPHome ≥ 2025.4.x).

### 11.2 Two ways to wire the panel

| Path | Data route | Needs HA? | On-device work |
|---|---|---|---|
| **A — via HA** | ESP (ESPHome native API) ⇄ HA ⇄ MQTT ⇄ MinerWatch | Yes | Minimal (bind to HA entities) |
| **B — direct** | ESP (ESPHome `mqtt`) ⇄ broker ⇄ MinerWatch | **No** | Subscribe to our topics; publish commands |

**Path B is the interesting one** and it costs us nothing extra: the topic
schema in §5 is *consumer-agnostic*, so the exact same topics that drive HA
also drive a DIY panel. Minimum stack becomes **MinerWatch → Mosquitto →
ESP32**, no HA required.

### 11.3 Why flat topics (§4.2 / §5)

In Path B the panel would otherwise have to parse the 20-field JSON
(`minerwatch/<mac>/state`) on-device — doable in an ESPHome lambda
(`json::parse_json`) but tedious. Enabling `mqtt.publish_flat_topics`
(§9) makes MinerWatch also emit scalar topics `minerwatch/<mac>/f/<field>`,
which ESPHome reads directly with a one-line `mqtt_subscribe` sensor. HA
keeps using the JSON `state` topic; the panel uses the flat ones. Both are
fed from the same `publish_state(...)`.

### 11.4 ESPHome config skeleton (Path B, direct)

Illustrative — display/touch platform lines depend on the exact board.

```yaml
substitutions:
  miner_mac: "aabbccddeeff"          # the MinerWatch <mac> id

esphome:
  name: minerwatch-panel

esp32:
  board: esp32-s3-devkitc-1

wifi:
  ssid: !secret wifi_ssid
  password: !secret wifi_password

# Talk straight to the broker MinerWatch publishes to.
mqtt:
  broker: localhost
  username: !secret mqtt_user
  password: !secret mqtt_pass

# --- Read live metrics from the FLAT topics (publish_flat_topics: true) ---
sensor:
  - platform: mqtt_subscribe
    name: "Hashrate"
    id: miner_hashrate
    topic: "minerwatch/${miner_mac}/f/hashrate_ths"
    unit_of_measurement: "TH/s"
  - platform: mqtt_subscribe
    name: "Chip temp"
    id: miner_temp
    topic: "minerwatch/${miner_mac}/f/temp_chip_c"
    unit_of_measurement: "°C"
  - platform: mqtt_subscribe
    name: "Power"
    id: miner_power
    topic: "minerwatch/${miner_mac}/f/power_w"
    unit_of_measurement: "W"

# --- Online/offline from the availability topic ---
text_sensor:
  - platform: mqtt_subscribe
    name: "Status"
    id: miner_status
    topic: "minerwatch/${miner_mac}/availability"

# --- A touch button that restarts the miner (needs allow_controls: true) ---
# Wire this to an LVGL button's on_click in the real UI.
button:
  - platform: template
    name: "Restart miner"
    on_press:
      - mqtt.publish:
          topic: "minerwatch/${miner_mac}/cmd/restart"
          payload: "RESTART"
          qos: 1

# display: / touchscreen: / lvgl:  → board-specific; LVGL widgets bind to
# the sensor ids above (e.g. a label showing id(miner_hashrate).state).
```

### 11.5 Suggested build order for the panel

1. MinerWatch side: implement `publish_flat_topics` (checklist §10 item 9) —
   it's a small addition to `publish_state(...)`.
2. ESPHome side: get the three `mqtt_subscribe` sensors + status showing as
   plain entities (no UI yet) to prove the data path.
3. Add the LVGL screen (labels + a gauge) bound to those sensor ids.
4. Add command buttons last, behind `allow_controls: true`, and lock them
   down with a broker ACL (§12).

### 11.6 Notes & caveats

- A **broker is still required** (Mosquitto). It can live on the MinerWatch
  host itself.
- Commands obey the same gate as HA: `mqtt.allow_controls` must be on, and
  the driver capability flag must be set (§7).
- ESPHome's native HA API and its `mqtt` component can coexist, so a panel
  can do Path A and B at once if ever useful.
- Per-miner panel: bind `${miner_mac}`. A multi-miner panel just subscribes
  to several macs (or a fleet-aggregate topic — see §13).

---

## 12. Security notes (see `security-review.md`)

- **Broker credentials at rest.** Same plaintext-in-`settings` issue as the
  auth password (review item **F3**). Store with the same hardening you pick
  there; never log them.
- **Command topics = remote control.** Anyone with broker write access can
  restart/retune miners. Document broker **ACLs** (restrict
  `minerwatch/+/cmd/#` to MinerWatch + HA only). Keep `allow_controls` off
  by default.
- **Plaintext MQTT (1883).** Credentials/data are cleartext on the LAN
  unless the broker uses TLS (8883). Offer a `tls: true` option and note the
  trade-off, consistent with the LAN-HTTP posture elsewhere.
- **No new inbound surface on MinerWatch.** We connect *out* to the broker;
  we don't open a port. That's a security plus over a REST-pull integration.

---

## 13. Open questions

- Expose MinerWatch-level concepts to HA too? e.g. a **switch** for the
  per-miner `enabled` flag, a `guardian_enabled` switch, an auto-fan target
  `number`. Nice, but they're MinerWatch state, not miner telemetry — decide
  scope for v1.
- Fleet aggregate entities (total hashrate / total power) as a synthetic
  "bridge" device? Cheap to add and very dashboard-friendly.
- Throttle: is per-poll (5s) publishing too chatty for large fleets? Hence
  `publish_interval_s`.
- Do we ever want the reverse — HA → MinerWatch — beyond MQTT commands
  (e.g. webhook)? Probably not for v1.
