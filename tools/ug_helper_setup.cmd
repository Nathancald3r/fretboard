@echo off
rem Sets up Fretboard's UG helper on this computer (run it once; again any time to repair).
title Set up Fretboard UG helper
setlocal
set "HOME=%USERPROFILE%\Fretboard UG helper"
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 8) else 1)" >nul 2>nul
if errorlevel 1 goto nopython
if not exist "%HOME%" mkdir "%HOME%"
python -c "import sys, urllib.request; urllib.request.urlretrieve(sys.argv[1], sys.argv[2])" "https://nathancald3r.github.io/fretboard/tools/ug_helper_setup.py" "%HOME%\ug_helper_setup.py"
if errorlevel 1 (
  echo Couldn't download the setup. Check the internet connection and run this again.
  pause
  exit /b 1
)
python "%HOME%\ug_helper_setup.py"
if errorlevel 1 (
  pause
  exit /b 1
)
rem The link Fretboard's Start UG helper button opens (this Windows user only). It runs start.cmd and nothing else.
set "KEY=HKCU\Software\Classes\fretboard-helper"
reg add "%KEY%" /ve /d "URL:Fretboard UG helper" /f >nul
reg add "%KEY%" /v "URL Protocol" /d "" /f >nul
reg add "%KEY%\shell\open\command" /ve /d "\"%ComSpec%\" /c \"\"%HOME%\start.cmd\"\"" /f >nul
if errorlevel 1 (
  echo Couldn't register the Start UG helper button.
  pause
  exit /b 1
)
echo   Start UG helper button: ok
echo.
echo Done. In Fretboard press Start UG helper (Chrome asks once whether to open it: tick Always allow).
echo The first time, log in to Ultimate Guitar in the helper's Chrome window. Official songs need your account;
echo Guitar Pro tabs don't.
echo.
pause
exit /b 0

:nopython
echo Python isn't installed on this computer. The Microsoft Store page for it opens now:
echo install it, then run this setup again.
start "" "ms-windows-store://pdp/?productid=9NCVDN91XZQP"
pause
exit /b 1
