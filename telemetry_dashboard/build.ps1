<#
Portable Windows build driver.

The Clean switch removes only enumerated compiler outputs. Compiler discovery
prefers GCC, then Clang, then MSVC; each branch uses warnings appropriate to
that compiler and links Winsock on native Windows. Native command exit codes
are promoted to terminating PowerShell errors.
#>
param(
  [switch]$Clean
)

$ErrorActionPreference = "Stop"

$IsNativeWindows =
  ($PSVersionTable.PSEdition -eq "Desktop") -or
  ((Get-Variable IsWindows -ErrorAction SilentlyContinue) -and $IsWindows)

$Target =
  if ($IsNativeWindows) {
    "dashboard_server.exe"
  } else {
    "dashboard_server"
  }

$Libs =
  if ($IsNativeWindows) {
    @("-lws2_32")
  } else {
    @("-lpthread", "-ldl", "-lm")
  }
function Assert-NativeSuccess {
  if ($LASTEXITCODE -ne 0) {
    # Stop the build with actionable diagnostics because continuing could leave an unusable telemetry executable.
    throw "Native build command failed with exit code $LASTEXITCODE."
  }
}

# Delete only the known server executables and object files produced by this
# project. Missing outputs are ignored, making both -Clean and rebuilds safe.
function Remove-BuildOutputs {
  $files = @(
    "dashboard_server.exe",
    "dashboard_server",
    "app.o",
    "mongoose.o",
    "sqlite3.o",
    "cJSON.o",
    "app.obj",
    "mongoose.obj",
    "sqlite3.obj",
    "cJSON.obj"
  )

  # Process each known build output or source unit so the requested operation covers the complete backend.
  foreach ($file in $files) {
    if (Test-Path -LiteralPath $file) {
      # Remove only this enumerated compiler output during an explicitly requested clean operation.
      Remove-Item -LiteralPath $file -Force
    }
  }
}

if ($Clean) {
  Remove-BuildOutputs
}

function Find-Command([string]$Name) {
  $command = Get-Command -Name $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

$gcc = Find-Command "gcc"
$cl = Find-Command "cl"
$clang = Find-Command "clang"

if ($gcc) {
  Write-Host "Building with GCC: $gcc"

  $appWarnings = @(
    "-Wall", "-Wextra", "-pedantic", "-Wconversion", "-Wsign-conversion",
    "-Wshadow", "-Wformat=2", "-Wundef", "-Wstrict-prototypes",
    "-Wmissing-prototypes", "-Wcast-qual", "-Wwrite-strings", "-Werror"
  )

  & $gcc -std=c11 -O2 @appWarnings -I. -c app.c -o app.o
  Assert-NativeSuccess
  & $gcc -std=c11 -O2 -Wall -Wextra -pedantic -I. -c mongoose.c -o mongoose.o
  Assert-NativeSuccess
  & $gcc -std=c11 -O2 -w -I. -c sqlite3.c -o sqlite3.o
  Assert-NativeSuccess
  & $gcc -std=c11 -O2 -Wall -Wextra -pedantic -I. -c cJSON.c -o cJSON.o
  Assert-NativeSuccess
  & $gcc app.o mongoose.o sqlite3.o cJSON.o -o $Target $Libs
  Assert-NativeSuccess

  Write-Host "Built $Target"
  exit 0
}

if ($clang) {
  Write-Host "Building with Clang: $clang"

  $appWarnings = @(
    "-Wall", "-Wextra", "-pedantic", "-Wconversion", "-Wsign-conversion",
    "-Wshadow", "-Wformat=2", "-Wundef", "-Wstrict-prototypes",
    "-Wmissing-prototypes", "-Wcast-qual", "-Wwrite-strings", "-Werror"
  )

  & $clang -std=c11 -O2 @appWarnings -I. -c app.c -o app.o
  Assert-NativeSuccess
  & $clang -std=c11 -O2 -Wall -Wextra -pedantic -I. -c mongoose.c -o mongoose.o
  Assert-NativeSuccess
  & $clang -std=c11 -O2 -w -I. -c sqlite3.c -o sqlite3.o
  Assert-NativeSuccess
  & $clang -std=c11 -O2 -Wall -Wextra -pedantic -I. -c cJSON.c -o cJSON.o
  Assert-NativeSuccess
  & $clang app.o mongoose.o sqlite3.o cJSON.o -o $Target $Libs
  Assert-NativeSuccess

  Write-Host "Built $Target"
  exit 0
}

if ($cl -and $IsNativeWindows) {
  Write-Host "Building with MSVC: $cl"

  & $cl /nologo /O2 /W4 /WX /I. /c app.c
  Assert-NativeSuccess
  & $cl /nologo /O2 /W3 /I. /c mongoose.c cJSON.c
  Assert-NativeSuccess
  & $cl /nologo /O2 /w /I. /c sqlite3.c
  Assert-NativeSuccess
  & $cl /nologo app.obj mongoose.obj sqlite3.obj cJSON.obj /Fe:$Target ws2_32.lib
  Assert-NativeSuccess

  Write-Host "Built $Target"
  exit 0
}

# Stop the build with actionable diagnostics because continuing could leave an unusable telemetry executable.
Write-Error @"
No supported C compiler was found on PATH.

Install one of:
  winget install MSYS2.MSYS2
  winget install LLVM.LLVM
  winget install Microsoft.VisualStudio.2022.BuildTools

Then open a new PowerShell window and run:
  .\build.ps1
"@
