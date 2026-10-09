@echo off
setlocal
cd /d "%~dp0"

if exist ".venv\Scripts\python.exe" goto use_venv

python visualizer.py
if errorlevel 1 goto failed
exit /b 0

:use_venv
".venv\Scripts\python.exe" visualizer.py
if errorlevel 1 goto failed
exit /b 0

:failed
echo Visualizer exited with an error. Check the message above.
pause
exit /b 1