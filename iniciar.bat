@echo off
echo ========================================
echo   ORCAMENTO PESSOAL - Iniciando...
echo ========================================

set NODE_PATH=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe

if not exist "%NODE_PATH%" (
  echo Buscando node no PATH...
  set NODE_PATH=node
)

echo Servidor iniciando em http://localhost:3000
echo Pressione Ctrl+C para parar.
echo.

start "" "http://localhost:3000"
"%NODE_PATH%" --experimental-sqlite "%~dp0server.js"
pause
