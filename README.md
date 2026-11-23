# PocketSignal web app (PWA)

Same engine as the desktop app (ported to JavaScript; parity-tested by `tests/test_web_parity.py`),
same design, Arabic RTL, Cairo font. Signal-only - never places trades.

* Data: Binance (crypto, no key), Twelve Data (FX/metals/stocks, key stored only in the browser), Simulation.
* OTC: not analysed (no official Pocket Option OTC price feed).
* Install on iPhone: open the site in Safari -> Share -> "Add to Home Screen".
* Local test: `python -m http.server -d web 8000` then open http://localhost:8000
