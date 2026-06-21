# Inverter Console

A self-hosted web frontend for an MPP Solar inverter, designed to run on a
Raspberry Pi connected to the inverter over USB (`/dev/hidraw0`, PI30 protocol).

It gives you:

* **Live dashboard** — metric tiles + time-series charts of the important
  stats (battery voltage, SOC, PV power, load power, charge/discharge current,
  AC voltages, heat-sink temperature), updated every few seconds.
* **Settings editor** — change inverter settings individually, with a
  review-and-confirm step before anything is written.
* **Preset profiles** — save named sets of settings (e.g. "Grid-charge
  overnight", "Solar only") and apply them in one click.
* **Dark mode** (default) with a light toggle.

It is built directly on top of the [`mpp-solar`](https://github.com/jblance/mpp-solar)
Python library (already installed on the Pi).

---

## How it talks to the inverter (and why it won't overload the link)

The inverter has a single, slow, half-duplex connection — only one command can
be in flight at a time. The backend is built around that constraint:

* **One owner of the device.** All inverter access goes through a single
  `InverterManager` that runs every command on a *one-worker* thread executor
  behind an `asyncio` lock. Polls and setting-writes can never overlap, and a
  minimum gap is enforced between any two transactions.
* **One poller, many viewers.** The server polls once on a fixed cadence and
  fans the results out to every browser over a WebSocket. Opening ten tabs does
  **not** create ten times the inverter traffic.
* **Staggered queries.** `QPIGS` (live numbers) every ~5 s; `QMOD` (mode) and
  `QPIWS` (warnings) less often.
* **Safe apply.** When you confirm a settings change, the manager takes the
  device lock for the *whole batch*, which pauses polling. It then sends each
  setter **one at a time** with a deliberate pause between them, checks the
  `ACK`/`NAK` for each, optionally issues a single `PSAVE` to persist to EEPROM,
  and finally re-reads the settings to confirm what actually stuck. Polling
  resumes automatically.

All of these timings are configurable via environment variables (see below).

---

## Quick start

### On the Raspberry Pi (real inverter)

```bash
git clone <this repo> ~/mppsolar-frontend
cd ~/mppsolar-frontend
./run.sh
```

`run.sh` creates a virtualenv, installs `fastapi`/`uvicorn` (and `mppsolar` if
not already present), and serves on <http://0.0.0.0:8080>. Open the Pi's
address from any device on your network.

Make sure the user can read/write the device node:

```bash
sudo cp 99-mppsolar.rules /etc/udev/rules.d/
sudo udevadm control --reload-rules && sudo udevadm trigger
sudo usermod -aG plugdev $USER   # then log out / back in
```

### Run as a service

```bash
sudo cp mppsolar-frontend.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now mppsolar-frontend
```

Edit the unit first to match your username and install path.

### Development (no inverter attached)

Use the library's built-in test port, which returns canned responses so the
whole UI works end-to-end without hardware:

```bash
MPPF_PORT=test ./run.sh
```

---

## Configuration

All settings are environment variables (sensible defaults shown):

| Variable | Default | Meaning |
|---|---|---|
| `MPPF_PORT` | `/dev/hidraw0` | Inverter port. Use `test` for development. |
| `MPPF_PROTOCOL` | `PI30` | mpp-solar protocol. |
| `MPPF_BAUD` | `2400` | Serial baud (ignored for HID). |
| `MPPF_POLL_INTERVAL` | `5` | Seconds between `QPIGS` polls. |
| `MPPF_MODE_EVERY` | `3` | Poll `QMOD` every N polls. |
| `MPPF_WARNINGS_EVERY` | `6` | Poll `QPIWS` every N polls. |
| `MPPF_MIN_COMMAND_GAP` | `0.2` | Min seconds between any two transactions. |
| `MPPF_APPLY_COMMAND_GAP` | `0.4` | Pause between setter commands when applying. |
| `MPPF_HTTP_PORT` | `8080` | Web server port. |
| `MPPF_DATA_DIR` | `./data` | Where the SQLite DB lives. |
| `MPPF_HISTORY_RETENTION_DAYS` | `14` | Days of history kept before pruning. |

---

## Layout

```
backend/
  config.py      runtime configuration (env vars)
  inverter.py    InverterManager: serialized device access, poller, apply jobs
  catalog.py     editable-settings catalog + validation (PI30 setters)
  storage.py     SQLite: time-series samples + preset profiles
  app.py         FastAPI: REST + WebSocket, serves the frontend
frontend/
  index.html     single-page UI
  styles.css     dark/light themes
  charts.js      tiny dependency-free canvas time-series chart
  app.js         application logic
mpp-solar/       the upstream library (clone)
```

## API summary

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/live` | latest live snapshot |
| GET | `/api/metrics` | metric metadata for charts |
| GET | `/api/history?range=3600` | downsampled time-series |
| GET | `/api/settings?refresh=1` | current editable settings |
| POST | `/api/settings/apply` | apply `{items:[{key,value}], save}` |
| GET | `/api/jobs/{id}` | apply-job progress |
| GET/POST | `/api/profiles` | list / create profiles |
| PUT/DELETE | `/api/profiles/{id}` | update / delete profile |
| POST | `/api/profiles/{id}/apply` | apply a saved profile |
| WS | `/ws` | live samples, status, settings & job updates |

## Settings menu

The editable settings are constrained to the **RCT 2K (24 V) model's documented
menu** so the UI can never offer an invalid value. Each control is limited to
the manual's allowed options/ranges and cross-references its program number
("Prog NN"). Two cross-field rules from the manual are enforced live:

* **Prog 11 (Max Utility Charge Current)** can never exceed **Prog 02 (Max
  Combined Charge Current)** — the utility options shrink as you lower Prog 02.
* **Progs 26/27/29 (Bulk / Float / Low-DC Cut-off voltages)** are locked unless
  **Prog 05 (Battery Type) = User-defined**, exactly as the manual specifies.

Program → command mapping lives in `backend/catalog.py`. **Equalization
(Progs 30, 31, 33–36) is not exposed**: the PI30 command set in this build of
`mpp-solar` has no setter for it, so those values cannot be written.

If you have a different model, adjust the option lists / ranges in
`backend/catalog.py`.

## Safety notes

* Changing inverter settings affects real power hardware. The UI always shows a
  review/confirm step and reports each command's `ACK`/`NAK`. Values are
  validated client- and server-side, but the inverter has the final say.
