@echo off
rem Opens the organizers VDA 5050 visualizer window (unmodified visualizer.py).
rem Start the stack first:  docker compose -f docker-compose.vda.yml up --build
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  python -m venv .venv || goto failed
  ".venv\Scripts\python.exe" -m pip install paho-mqtt matplotlib tomli || goto failed
)
".venv\Scripts\python.exe" visualizer.py
if errorlevel 1 goto failed
exit /b 0
:failed
echo Something failed. Is Python 3.11+ installed? Is Docker running?
pause
exit /b 1
