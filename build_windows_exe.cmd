@echo off
setlocal
cd /d "%~dp0"

echo Step 1/3: installing build dependencies...
python -m pip install -r requirements-windows.txt
if errorlevel 1 goto failed

echo Step 2/3: building single-file exe...
python -m PyInstaller --clean --noconfirm roce-console.spec
if errorlevel 1 goto failed

echo Step 3/3: done.
echo.
echo Output:
echo   %cd%\dist\RoCE批量打流控制台.exe
echo.
echo Double-click the exe to start the web console.
echo Data will be saved beside the exe in data\.
pause
exit /b 0

:failed
echo.
echo Build failed. Please check the error above.
pause
exit /b 1
