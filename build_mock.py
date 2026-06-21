"""Build a single self-contained mockup HTML from the real frontend.

Inlines styles.css + charts.js + app.js and injects mock.js (which overrides
fetch/WebSocket with a simulated 24 V inverter). The settings view is computed
from the real catalog so the demo matches the actual UI exactly.
"""
import json
from pathlib import Path

from backend import catalog, storage

FE = Path(__file__).parent / "frontend"

# A realistic 24 V (RCT 2K) decoded QPIRI/QFLAG so the demo shows in-range values
# and unlocks the custom-voltage fields (Battery Type = User).
fake = {
    "Output Source Priority": ["SBU first", ""],
    "Charger Source Priority": ["Solar + Utility", ""],
    "Battery Type": ["User", ""],
    "AC Output Frequency": [50.0, "Hz"],
    "Input Voltage Range": ["Appliance", ""],
    "Max Charging Current": [40, "A"],
    "Max AC Charging Current": [20, "A"],
    "Battery Recharge Voltage": [23.0, "V"],
    "Battery Redischarge Voltage": [0.0, "V"],
    "Battery Bulk Charge Voltage": [28.2, "V"],
    "Battery Float Charge Voltage": [27.0, "V"],
    "Battery Under Voltage": [21.0, "V"],
    "Buzzer": ["enabled", ""],
    "Overload Bypass": ["disabled", ""],
    "LCD Reset to Default": ["enabled", ""],
    "Overload Restart": ["disabled", ""],
    "Over Temperature Restart": ["enabled", ""],
    "LCD Backlight": ["enabled", ""],
    "Primary Source Interrupt Alarm": ["enabled", ""],
    "Record Fault Code": ["enabled", ""],
}

settings_view = catalog.build_view(fake)
metrics = [{"key": k, "label": label, "unit": unit}
           for k, (field, label, unit) in storage.METRICS.items()]

mock_js = (FE / "mock.js").read_text()
mock_js = mock_js.replace("/*__METRICS__*/ []", json.dumps(metrics))
mock_js = mock_js.replace("/*__SETTINGS_VIEW__*/ []", json.dumps(settings_view))

css = (FE / "styles.css").read_text()
charts_js = (FE / "charts.js").read_text()
app_js = (FE / "app.js").read_text()
html = (FE / "index.html").read_text()

html = html.replace('<link rel="stylesheet" href="styles.css" />', f"<style>\n{css}\n</style>")
# inject mock BEFORE charts/app so it overrides fetch/WebSocket first
html = html.replace('<script src="charts.js"></script>',
                    f"<script>\n{mock_js}\n</script>\n  <script>\n{charts_js}\n</script>")
html = html.replace('<script src="app.js"></script>', f"<script>\n{app_js}\n</script>")
html = html.replace("<title>Inverter Console</title>", "<title>Inverter Console — Demo</title>")

# small banner so it's clearly a simulation
html = html.replace('<div class="sub" id="device-sub">MPP Solar · PI30</div>',
                    '<div class="sub" id="device-sub">MPP Solar · PI30 · <b style="color:var(--warn)">DEMO (simulated data)</b></div>')

out = Path(__file__).parent / "mockup.html"
out.write_text(html)
print(f"wrote {out}  ({len(html)//1024} KB)  settings={len(settings_view)} metrics={len(metrics)}")
