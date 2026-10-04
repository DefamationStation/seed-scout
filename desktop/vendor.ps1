# Fetches what the installed app brings with it, into desktop/vendor:
#   python  the official embeddable Python (the backend only uses the standard library)
#   jdk     a trimmed Java runtime with the compiler, built by jlink from the JDK in -Jdk or JAVA_HOME
param([string]$Jdk = $env:JAVA_HOME, [string]$PythonVersion = '3.13.7')
$ErrorActionPreference = 'Stop'
$vendor = Join-Path $PSScriptRoot 'vendor'
if (-not $Jdk -or -not (Test-Path (Join-Path $Jdk 'bin\jlink.exe'))) { throw 'Pass -Jdk <folder of a JDK 25> or set JAVA_HOME.' }
if (Test-Path $vendor) { Remove-Item -Recurse -Force $vendor }
New-Item -ItemType Directory -Force $vendor | Out-Null

$zip = Join-Path $vendor 'python.zip'
Invoke-WebRequest "https://www.python.org/ftp/python/$PythonVersion/python-$PythonVersion-embed-amd64.zip" -OutFile $zip
Expand-Archive $zip (Join-Path $vendor 'python'); Remove-Item $zip
# The embeddable build ignores the script's own folder; app.py imports build.py from there.
$pth = Get-ChildItem (Join-Path $vendor 'python') -Filter 'python*._pth' | Select-Object -First 1
Add-Content $pth.FullName '..\app'

# java.se covers what the game's world generation uses; the rest: the compiler, sun.misc.Unsafe, and reading jars as file systems.
& (Join-Path $Jdk 'bin\jlink.exe') --add-modules java.se,jdk.compiler,jdk.unsupported,jdk.zipfs,jdk.management `
  --strip-debug --no-header-files --no-man-pages --compress zip-6 --output (Join-Path $vendor 'jdk')
if ($LASTEXITCODE) { throw 'jlink failed' }
"python: $((Get-ChildItem (Join-Path $vendor 'python') -Recurse | Measure-Object Length -Sum).Sum / 1MB -as [int]) MB, jdk: $((Get-ChildItem (Join-Path $vendor 'jdk') -Recurse | Measure-Object Length -Sum).Sum / 1MB -as [int]) MB"
