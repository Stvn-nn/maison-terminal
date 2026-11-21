<#
.SYNOPSIS
  Packages python-core (the analytical engine) into a standalone folder with PyInstaller.

.DESCRIPTION
  Output: engine-build/dist/maison-core/maison-core.exe plus its _internal/ folder.
  The desktop installer ships this folder (see src-tauri/tauri.engine.conf.json) and the app
  starts it on launch, so end users need no Python installation.

  Requires the engine's dependencies and PyInstaller in the chosen Python environment:
    python -m pip install -r python-core/requirements.txt pyinstaller

.EXAMPLE
  ./scripts/build-engine.ps1
  ./scripts/build-engine.ps1 -PythonExecutable python-core/.venv/Scripts/python.exe
#>
param(
  [string]$PythonExecutable = "python"
)

$ErrorActionPreference = "Stop"
$repositoryRoot = Split-Path -Parent $PSScriptRoot
$pythonCoreDirectory = Join-Path $repositoryRoot "python-core"
$engineBuildDirectory = Join-Path $repositoryRoot "engine-build"

$pyInstallerArguments = @(
  "-m", "PyInstaller",
  "--noconfirm", "--clean",
  "--onedir",          # folder output: starts in a few seconds (onefile unpacks on every launch)
  "--console",         # the app launches it with CREATE_NO_WINDOW, so no window appears
  "--name", "maison-core",
  "--distpath", (Join-Path $engineBuildDirectory "dist"),
  "--workpath", (Join-Path $engineBuildDirectory "work"),
  "--specpath", $engineBuildDirectory,
  "--paths", $pythonCoreDirectory,
  "--collect-submodules", "uvicorn",       # uvicorn picks loop/protocol modules dynamically
  "--collect-all", "pandas_ta_classic",
  "--exclude-module", "tkinter",
  "--exclude-module", "pytest",
  (Join-Path $pythonCoreDirectory "main.py")
)

& $PythonExecutable @pyInstallerArguments
if ($LASTEXITCODE -ne 0) {
  throw "PyInstaller failed with exit code $LASTEXITCODE"
}

$engineExecutable = Join-Path $engineBuildDirectory "dist/maison-core/maison-core.exe"
if (-not (Test-Path $engineExecutable)) {
  throw "Expected engine executable was not produced: $engineExecutable"
}
Write-Host "Packaged engine: $engineExecutable"
