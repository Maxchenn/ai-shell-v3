@echo off
setlocal
cd /d "%~dp0"
if not exist node_modules (
  echo Installing npm dependencies...
  call npm install || exit /b 1
)
call npm run tauri:dev
