"""Editable-settings catalog for the PI30 protocol, constrained to the
RCT 2K (24 V) inverter's documented menu.

This is the bridge between the raw mpp-solar setter commands (POP, PCP, PBCV,
PE/PD, ...) and a friendly UI.  Every option here is restricted to what the
user manual lists as valid for this model, so the UI cannot offer an invalid
choice.  For each editable setting we describe:

* how to render a control (type, options, numeric range/unit),
* how to read the *current* value out of a decoded QPIRI / QFLAG response,
* how to turn a chosen value into a concrete setter command string,
* how to validate a chosen value,
* optional cross-field dependencies (e.g. Prog 11 <= Prog 02; Progs 26/27/29
  require Battery Type = User).

Everything is plain data + small pure functions so the catalog can be
serialised to JSON for the frontend and reused server-side for validation.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Callable, Optional

# Inverter ACK/NAK markers as decoded by mpp-solar.
ACK_KEY = "Command execution"
ACK_OK = "Successful"

# Battery Type code that unlocks custom voltage programs (Prog 05 USE).
USER_BATTERY_CODE = "02"


@dataclass
class Setting:
    key: str                     # stable identifier used by the API/UI
    label: str
    group: str
    type: str                    # "enum" | "number" | "flag"
    command: str                 # setter command prefix, e.g. "POP"
    prog: str = ""               # manual program number, for cross-reference
    help: str = ""
    unit: str = ""
    options: list[dict] = field(default_factory=list)   # enum: [{value, label}]
    minimum: Optional[float] = None
    maximum: Optional[float] = None
    step: Optional[float] = None
    advanced: bool = False       # hidden in a collapsed "Advanced" section
    depends: dict = field(default_factory=dict)          # cross-field rules
    # internal helpers (not serialised)
    _suffix: Optional[Callable[[object], str]] = None
    _regex: Optional[str] = None
    _read: Optional[Callable[[dict], object]] = None
    flag_letter: Optional[str] = None

    def to_dict(self) -> dict:
        return {
            "key": self.key, "label": self.label, "group": self.group,
            "type": self.type, "command": self.command, "prog": self.prog,
            "help": self.help, "unit": self.unit, "options": self.options,
            "minimum": self.minimum, "maximum": self.maximum, "step": self.step,
            "advanced": self.advanced, "depends": self.depends,
        }

    # -- command construction & validation ---------------------------------
    def build_command(self, value) -> str:
        if self.type == "flag":
            if isinstance(value, str):
                truthy = value.lower() in ("enabled", "true", "on", "1")
            else:
                truthy = bool(value)
            return ("PE" if truthy else "PD") + self.flag_letter

        if self.type == "enum":
            value = str(value)
            if value not in {o["value"] for o in self.options}:
                raise ValueError(f"{self.label}: '{value}' is not a valid option")
            cmd = self.command + (self._suffix(value) if self._suffix else value)
        elif self.type == "number":
            try:
                num = float(value)
            except (TypeError, ValueError):
                raise ValueError(f"{self.label}: '{value}' is not a number")
            if self.minimum is not None and num < self.minimum:
                raise ValueError(f"{self.label}: {num} below minimum {self.minimum}")
            if self.maximum is not None and num > self.maximum:
                raise ValueError(f"{self.label}: {num} above maximum {self.maximum}")
            cmd = self.command + (self._suffix(num) if self._suffix else str(num))
        else:
            raise ValueError(f"Unsupported setting type {self.type}")

        if self._regex and not re.fullmatch(self._regex, cmd):
            raise ValueError(f"{self.label}: value '{value}' produced invalid command '{cmd}'")
        return cmd

    def current_value(self, settings: dict):
        if self._read is None:
            return None
        try:
            return self._read(settings)
        except Exception:
            return None


def _val(settings: dict, key: str):
    item = settings.get(key)
    if isinstance(item, (list, tuple)) and item:
        return item[0]
    return item


# ---------------------------------------------------------------------------
# readers (decoded QPIRI/QFLAG -> control value space)
# ---------------------------------------------------------------------------
def _enum_reader(qpiri_key: str, string_to_code: dict):
    def reader(settings):
        raw = _val(settings, qpiri_key)
        return None if raw is None else string_to_code.get(str(raw))
    return reader


def _number_reader(qpiri_key: str):
    def reader(settings):
        v = _val(settings, qpiri_key)
        try:
            return round(float(v), 1)
        except (TypeError, ValueError):
            return None
    return reader


def _voltage_enum_reader(qpiri_key: str):
    """Map a decoded float voltage to its NN.N option code (e.g. 23.0 -> '23.0')."""
    def reader(settings):
        v = _val(settings, qpiri_key)
        try:
            return f"{float(v):04.1f}"
        except (TypeError, ValueError):
            return None
    return reader


def _voltage_suffix(num: float) -> str:
    return f"{num:04.1f}"


def _volt_options(values, full_first=False):
    opts = []
    if full_first:
        opts.append({"value": "00.0", "label": "Full (float)"})
    for v in values:
        opts.append({"value": f"{v:04.1f}", "label": f"{v:.1f} V"})
    return opts


def _frange(start, stop, step):
    out, v = [], start
    while v <= stop + 1e-9:
        out.append(round(v, 1))
        v += step
    return out


# ---------------------------------------------------------------------------
# Catalog (RCT 2K menu)
# ---------------------------------------------------------------------------
OUTPUT_SOURCE = Setting(
    key="output_source_priority", label="Output Priority", group="Operation & Charging",
    type="enum", command="POP", prog="01",
    help="Which source powers the loads first.",
    options=[
        {"value": "00", "label": "Utility first"},
        {"value": "01", "label": "Solar first"},
        {"value": "02", "label": "SBU (Solar / Battery / Utility)"},
    ],
    _regex=r"POP0[012]",
    _read=_enum_reader("Output Source Priority",
                       {"Utility first": "00", "Solar first": "01", "SBU first": "02"}),
)

MAX_CHARGE_CURRENT = Setting(
    key="max_charge_current", label="Max Combined Charge Current", group="Operation, Charging & Battery",
    type="enum", command="MCHGC", prog="02", unit="A", advanced=True,
    help="Maximum total battery charging current (solar + utility).",
    options=[{"value": str(a), "label": f"{a} A"} for a in (10, 20, 30, 40, 50, 60)],
    _suffix=lambda v: f"0{int(v):02d}", _regex=r"MCHGC\d\d\d",
    _read=_number_reader("Max Charging Current"),
)

GRID_RANGE = Setting(
    key="grid_working_range", label="AC Input Range", group="Operation, Charging & Battery",
    type="enum", command="PGR", prog="03", advanced=True,
    help="Acceptable AC-in window. Appliance = 90–280 VAC; UPS = 170–280 VAC (stricter).",
    options=[{"value": "00", "label": "Appliance (90–280 V)"},
             {"value": "01", "label": "UPS (170–280 V)"}],
    _regex=r"PGR0[01]",
    _read=_enum_reader("Input Voltage Range", {"Appliance": "00", "UPS": "01"}),
)

BATTERY_TYPE = Setting(
    key="battery_type", label="Battery Type", group="Operation, Charging & Battery",
    type="enum", command="PBT", prog="05", advanced=True,
    help="Battery chemistry preset. 'User-defined' unlocks the custom charge voltages (Prog 26/27/29).",
    options=[{"value": "00", "label": "AGM"},
             {"value": "01", "label": "Flooded"},
             {"value": "02", "label": "User-defined"}],
    _regex=r"PBT0[012]",
    _read=_enum_reader("Battery Type", {"AGM": "00", "Flooded": "01", "User": "02"}),
)

OUTPUT_FREQ = Setting(
    key="output_frequency", label="Output Frequency", group="Operation, Charging & Battery",
    type="enum", command="F", prog="09", unit="Hz", advanced=True,
    help="AC output frequency.",
    options=[{"value": "50", "label": "50 Hz"}, {"value": "60", "label": "60 Hz"}],
    _regex=r"F[56]0",
    _read=lambda s: ("50" if str(_val(s, "AC Output Frequency")).startswith("50")
                     else "60" if str(_val(s, "AC Output Frequency")).startswith("60")
                     else None),
)

MAX_UTILITY_CHARGE_CURRENT = Setting(
    key="max_utility_charge_current", label="Max Utility Charge Current", group="Operation, Charging & Battery",
    type="enum", command="MUCHGC", prog="11", unit="A", advanced=True,
    help="Maximum charging current drawn from utility. Cannot exceed the combined charge current (Prog 02).",
    options=[{"value": str(a), "label": f"{a} A"} for a in (2, 10, 20, 30, 40)],
    depends={"max_from": "max_charge_current"},
    _suffix=lambda v: f"0{int(v):02d}", _regex=r"MUCHGC\d\d\d",
    _read=_number_reader("Max AC Charging Current"),
)

BACK_TO_UTILITY = Setting(
    key="recharge_voltage", label="Back-to-Utility Voltage", group="Battery Voltages",
    type="enum", command="PBCV", prog="12", unit="V",
    help="In Solar/SBU modes, battery voltage at which the inverter switches back to utility (low-battery cut-over).",
    options=_volt_options(_frange(22.0, 25.5, 0.5)),
    _regex=r"PBCV\d\d\.\d", _read=_voltage_enum_reader("Battery Recharge Voltage"),
)

BACK_TO_BATTERY = Setting(
    key="redischarge_voltage", label="Back-to-Battery Voltage", group="Battery Voltages",
    type="enum", command="PBDV", prog="13", unit="V",
    help="In Solar/SBU modes, battery voltage at which the inverter disconnects from utility. 'Full' = wait until fully charged.",
    options=_volt_options(_frange(24.0, 29.0, 0.5), full_first=True),
    _regex=r"PBDV\d\d\.\d", _read=_voltage_enum_reader("Battery Redischarge Voltage"),
)

CHARGER_SOURCE = Setting(
    key="charger_source_priority", label="Charger Source Priority", group="Operation & Charging",
    type="enum", command="PCP", prog="16",
    help="Which source is allowed to charge the battery.",
    options=[
        {"value": "00", "label": "Utility first"},
        {"value": "01", "label": "Solar first"},
        {"value": "02", "label": "Solar + Utility"},
        {"value": "03", "label": "Only Solar"},
    ],
    _regex=r"PCP0[0123]",
    _read=_enum_reader("Charger Source Priority",
                       {"Utility first": "00", "Solar first": "01",
                        "Solar + Utility": "02", "Only solar charging permitted": "03"}),
)

# Custom charge voltages — only adjustable when Battery Type = User-defined (Prog 05 USE).
_requires_user = {"requires_key": "battery_type", "requires_value": USER_BATTERY_CODE}

BULK_VOLTAGE = Setting(
    key="bulk_charge_voltage", label="Bulk / C.V. Charge Voltage", group="Battery Voltages",
    type="number", command="PCVV", prog="26", unit="V", minimum=25.0, maximum=30.0, step=0.1,
    help="Constant-voltage (absorb) charge target. Factory default 28.2 V. Adjustable only with Battery Type = User-defined.",
    depends=_requires_user, _suffix=_voltage_suffix, _regex=r"PCVV\d\d\.\d",
    _read=_number_reader("Battery Bulk Charge Voltage"),
)

FLOAT_VOLTAGE = Setting(
    key="float_charge_voltage", label="Float Charge Voltage", group="Battery Voltages",
    type="number", command="PBFT", prog="27", unit="V", minimum=25.0, maximum=30.0, step=0.1,
    help="Float (maintenance) charge voltage. Factory default 27.0 V. Adjustable only with Battery Type = User-defined.",
    depends=_requires_user, _suffix=_voltage_suffix, _regex=r"PBFT\d\d\.\d",
    _read=_number_reader("Battery Float Charge Voltage"),
)

CUTOFF_VOLTAGE = Setting(
    key="cutoff_voltage", label="Low-DC Cut-off Voltage", group="Battery Voltages",
    type="number", command="PSDV", prog="29", unit="V", minimum=21.0, maximum=24.0, step=0.1,
    help="Battery cut-off (low) voltage. Factory default 21.0 V. Adjustable only with Battery Type = User-defined.",
    depends=_requires_user, _suffix=_voltage_suffix, _regex=r"PSDV\d\d\.\d",
    _read=_number_reader("Battery Under Voltage"),
)

# ---------------------------------------------------------------------------
# Toggle flags (PE<x>/PD<x>) keyed by QFLAG decoded names
# ---------------------------------------------------------------------------
_FLAG_DEFS = [
    # key, label, prog, PE/PD letter, QFLAG decoded name
    ("overload_restart", "Auto-Restart on Overload", "06", "u", "Overload Restart"),
    ("overtemp_restart", "Auto-Restart on Over-Temperature", "07", "v", "Over Temperature Restart"),
    ("buzzer", "Alarm / Buzzer", "18", "a", "Buzzer"),
    ("lcd_timeout", "Auto-Return to Default Screen (1 min)", "19", "k", "LCD Reset to Default"),
    ("backlight", "LCD Backlight", "20", "x", "LCD Backlight"),
    ("source_interrupt_alarm", "Primary Source Interrupt Beep", "22", "y", "Primary Source Interrupt Alarm"),
    ("overload_bypass", "Overload Bypass", "23", "b", "Overload Bypass"),
    ("fault_record", "Fault Code Recording", "25", "z", "Record Fault Code"),
]


def _flag_reader(qflag_name: str):
    def reader(settings):
        v = _val(settings, qflag_name)
        return None if v is None else str(v).lower() == "enabled"
    return reader


FLAG_SETTINGS = [
    Setting(key=key, label=label, group="Toggles", type="flag", command="PE/PD",
            prog=prog, flag_letter=letter, advanced=True, help=f"Enable or disable: {label}.",
            _read=_flag_reader(qflag_name))
    for (key, label, prog, letter, qflag_name) in _FLAG_DEFS
]

# Order shown in the UI.
SETTINGS: list[Setting] = [
    OUTPUT_SOURCE, GRID_RANGE, OUTPUT_FREQ,
    CHARGER_SOURCE, MAX_CHARGE_CURRENT, MAX_UTILITY_CHARGE_CURRENT,
    BATTERY_TYPE,
    BACK_TO_UTILITY, BACK_TO_BATTERY, BULK_VOLTAGE, FLOAT_VOLTAGE, CUTOFF_VOLTAGE,
    *FLAG_SETTINGS,
]

BY_KEY = {s.key: s for s in SETTINGS}


def build_view(settings: dict, *_ignored) -> list[dict]:
    """Build the editable-settings view (catalog + current values) for the UI.

    Extra positional args are accepted/ignored for backward compatibility with
    callers that used to pass dynamic charge-current option strings; the option
    sets are now fixed to the documented menu.
    """
    view = []
    for s in SETTINGS:
        cur = s.current_value(settings)
        if s.type == "enum" and isinstance(cur, float):
            cur = str(int(cur))
        d = s.to_dict()
        d["current"] = cur
        view.append(d)
    return view


def validate_and_build(key: str, value) -> str:
    s = BY_KEY.get(key)
    if s is None:
        raise ValueError(f"Unknown setting '{key}'")
    return s.build_command(value)
