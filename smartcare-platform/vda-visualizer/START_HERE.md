# Organizers' VDA 5050 visualizer window (unmodified)
Shows the robots moving live, in parallel with the SmartCare UI. It only listens to the broker (localhost:1883).

1. `docker compose -f docker-compose.vda.yml up --build` (repo root)
2. Double-click `start_vda_window.bat` (Windows, needs Python 3.11+), or: `pip install paho-mqtt matplotlib tomli` then `python visualizer.py`
3. Create tasks in the SmartCare UI (http://localhost:8081); the same robots move in this window.
