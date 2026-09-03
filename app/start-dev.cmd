@echo off
cd /d "%~dp0"
npx tauri dev -c "{\"build\":{\"beforeDevCommand\":\"npm run dev\"}}"
