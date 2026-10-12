@echo off
chcp 65001 >nul 2>nul
echo 正在停止 高考志愿助手 ...
taskkill /f /im node.exe >nul 2>nul
echo 已尝试结束 node.exe 进程。
timeout /t 2 >nul
