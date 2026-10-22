@echo off
rem Opens the UG collector Chrome and links it to Fretboard (Find tabs online). Leave this window open.
cd /d "%~dp0"
python tools\ug_watch.py
pause
