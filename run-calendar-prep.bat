@echo off
REM Overnight calendar prep. Wired into Windows Task Scheduler at 6:15 AM daily.
REM See USAGE.md for the Task Scheduler setup walkthrough.
REM Diagnose problems with:  npm run check:scheduler

setlocal

set "COS_DIR=C:\Users\alexa\OneDrive\Documents\GSB\claude\chief-of-staff"
cd /d "%COS_DIR%"
if errorlevel 1 (
    echo [%date% %time%] FATAL cannot cd to %COS_DIR% >> "logs\scheduler.log"
    exit /b 1
)

REM Ensure logs directory exists.
if not exist "logs" mkdir "logs"

REM Mark the run starting so silent failures are visible in the rolling log.
echo [%date% %time%] starting /calendar-prep in %COS_DIR% >> "logs\scheduler.log"

REM Pass --mcp-config explicitly. Auto-discovery of project-scoped .mcp.json is
REM not always reliable when claude runs headless under Task Scheduler.
claude -p "/calendar-prep" --dangerously-skip-permissions --mcp-config ".mcp.json" >> "logs\scheduler.log" 2>&1
set "EXITCODE=%ERRORLEVEL%"

if not "%EXITCODE%"=="0" (
    echo [%date% %time%] FAIL claude -p exited with %EXITCODE% >> "logs\scheduler.log"
) else (
    echo [%date% %time%] DONE /calendar-prep exit 0 >> "logs\scheduler.log"
)

exit /b %EXITCODE%
