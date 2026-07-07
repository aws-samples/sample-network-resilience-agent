@echo off
REM Start a local web server to serve the app.
REM Usage: start.bat [port]

set PORT=%1
if "%PORT%"=="" set PORT=3000

echo Starting DX Visualizer on http://localhost:%PORT%
echo Press Ctrl+C to stop.
echo.

where python >nul 2>nul
if %ERRORLEVEL%==0 (
    python -m http.server %PORT% --directory "%~dp0"
    goto :eof
)

where python3 >nul 2>nul
if %ERRORLEVEL%==0 (
    python3 -m http.server %PORT% --directory "%~dp0"
    goto :eof
)

where npx >nul 2>nul
if %ERRORLEVEL%==0 (
    npx --yes serve "%~dp0" -l %PORT% -s
    goto :eof
)

echo Error: No suitable server found.
echo Please install Python 3 or Node.js, then try again.
pause
