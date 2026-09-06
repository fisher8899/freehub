@echo off
chcp 65001 >nul
title FreeHub - 免费 Token 情报站
cd /d "%~dp0"
echo ============================================
echo   FreeHub 免费 Token 情报站
echo   启动后访问 http://127.0.0.1:8619
echo   关闭本窗口即停止服务
echo ============================================
node server\index.js
pause
