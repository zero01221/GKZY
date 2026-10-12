@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0\.."

echo.
echo   高考志愿助手 · 安装便携运行时
echo   ================================================
echo.

if exist "高考志愿助手\runtime\node.exe" (
  echo   [跳过] runtime\node.exe 已存在
  echo.
  pause
  exit /b 0
)

where node >nul 2>nul
if errorlevel 1 goto NONODE

echo   找到系统 Node.js，正在复制到交付目录 ...
if not exist "高考志愿助手\runtime" mkdir "高考志愿助手\runtime"

for /f "delims=" %%i in ('where node') do (
  copy /y "%%i" "高考志愿助手\runtime\node.exe" >nul
  goto COPIED
)

:COPIED
if exist "高考志愿助手\runtime\node.exe" (
  echo   [完成] 已生成 高考志愿助手\runtime\node.exe
  echo   现在可以双击 高考志愿助手\启动.bat 使用了。
) else (
  echo   [失败] 复制失败，请手动把 node.exe 放到 高考志愿助手\runtime\ 下。
)
echo.
pause
exit /b 0

:NONODE
echo   [提示] 系统未安装 Node.js，且交付目录内也没有 runtime\node.exe。
echo.
echo   两种解决办法：
echo     1) 到 https://nodejs.org 下载安装 Node.js（LTS 版），再运行本脚本；
echo     2) 直接下载带运行时的完整发行包（Release 中的 zip）。
echo.
pause
exit /b 1
