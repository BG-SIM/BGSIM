@echo off
chcp 65001 >nul
title 酒馆战棋 · 模拟器
cd /d "%~dp0"
if not exist node_modules (
  echo 首次运行，正在安装依赖...
  call npm install
)
call npm run start
pause
