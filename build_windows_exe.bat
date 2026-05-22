@echo off
setlocal
cd /d "%~dp0"

echo [1/3] Installing build dependencies...
py -3 -m pip install -r requirements-windows.txt
if errorlevel 1 goto failed

echo [2/3] Building single-file exe...
py -3 -m PyInstaller --clean --noconfirm roce-console.spec
if errorlevel 1 goto failed

echo [3/3] Done.
echo.
echo Output:
echo   %cd%\dist\RoCE批量打流控制台.exe
echo.
echo Double-click the exe to start the web console. Data will be saved beside the exe in data\.
pause
exit /b 0

:failed
echo.
echo Build failed. Please check the error above.
pause
exit /b 1
