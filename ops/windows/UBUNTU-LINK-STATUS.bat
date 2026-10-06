@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0UBUNTU-LINK-STATUS.ps1"
exit /b %ERRORLEVEL%
