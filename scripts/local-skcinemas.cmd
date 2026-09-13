@echo off
setlocal
cd /d "%~dp0.."
if not exist ".cache\local-skcinemas" mkdir ".cache\local-skcinemas"
set "TASK_LOG=.cache\local-skcinemas\windows-task.log"
if exist "%TASK_LOG%" for %%I in ("%TASK_LOG%") do if %%~zI GTR 262144 move /y "%TASK_LOG%" ".cache\local-skcinemas\windows-task.previous.log" >NUL
echo [%date% %time%] WSL collector launch >>"%TASK_LOG%"
echo Distribution=[%~1] LinuxUser=[%~2] >>"%TASK_LOG%"
rem Installer validates the two names as [A-Za-z0-9_.-]+. This WSL build misreads quoted distro names from scheduled commands.
"%SystemRoot%\System32\wsl.exe" --distribution %~1 --user %~2 --cd "%~3" --exec /usr/bin/bash scripts/local-skcinemas.sh <NUL >>"%TASK_LOG%" 2>&1
set "TASK_EXIT=%ERRORLEVEL%"
echo [%date% %time%] Exit %TASK_EXIT% >>"%TASK_LOG%"
exit /b %TASK_EXIT%
