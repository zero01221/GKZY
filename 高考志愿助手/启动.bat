@echo off
chcp 65001 >nul 2>nul
title 高考志愿助手
cd /d "%~dp0"

echo.
echo   ============================================
echo      高考志愿助手  正在启动 ...
echo   ============================================
echo.

if exist "runtime\node.exe" goto RUNBUNDLED
where node >nul 2>nul
if errorlevel 1 goto NONODE
echo   [提示] 使用系统已安装的 Node.js 运行
node "server\server.mjs" --port 8765 --open
goto END

:RUNBUNDLED
"runtime\node.exe" "server\server.mjs" --port 8765 --open
goto END

:NONODE
echo   [错误] 未找到运行环境 runtime\node.exe
echo.
echo   请确认解压时保留了 runtime 子文件夹。
echo   若杀毒软件删除了它，请将其恢复后重试。
echo.
pause
exit /b 1

:END
echo.
echo   程序已退出。
pause
