@echo off
cd /d "%~dp0ElCompanion"
dotnet build -c Release
echo.
echo 构建完成！把 bin\Release\net6.0\ 里的 ElCompanion.dll 和 manifest.json 复制到：
echo E:\steam\steamapps\common\Stardew Valley\Mods\ElCompanion\
pause
