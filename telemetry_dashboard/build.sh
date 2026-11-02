#!/usr/bin/env sh
# Portable Unix build driver. It validates arguments, optionally removes only
# known build outputs, selects the available C compiler, and links pthread,
# dynamic-loader, and math dependencies required by the backend.
set -eu

clean=0

if [ "${1:-}" = "clean" ] || [ "${1:-}" = "--clean" ]; then
  clean=1
fi

if [ "$clean" -eq 1 ]; then
  rm -f dashboard_server dashboard_server.exe app.o mongoose.o sqlite3.o cJSON.o
fi

cc="${CC:-}"

if [ -z "$cc" ]; then
  if command -v gcc >/dev/null 2>&1; then
    cc=gcc
  elif command -v clang >/dev/null 2>&1; then
    cc=clang
  # Handle the alternative telemetry case when the preceding condition did not apply.
  else
    echo "No C compiler found. Install gcc or clang, or set CC." >&2
    exit 1
  fi
fi

# Handle this specific telemetry event or category within the surrounding selection.
case "$(uname -s)" in
  Linux*)
    libs="-lpthread -ldl -lm"
    platform_flags="-D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=200809L -DMG_ARCH=MG_ARCH_UNIX"
    ;;
  Darwin*)
    libs="-lpthread -ldl -lm"
    platform_flags="-D_DARWIN_C_SOURCE -DMG_ARCH=MG_ARCH_UNIX"
    ;;
  MINGW*|MSYS*|CYGWIN*)
    libs="-lws2_32"
    platform_flags=""
    ;;
  *)
    libs="-lpthread -ldl -lm"
    platform_flags=""
    ;;
esac

app_flags="-std=c11 -O2 -Wall -Wextra -pedantic -Wconversion -Wsign-conversion -Wshadow -Wformat=2 -Wundef -Wstrict-prototypes -Wmissing-prototypes -Wcast-qual -Wwrite-strings -Werror -I. $platform_flags"

# shellcheck disable=SC2086
"$cc" $app_flags -c app.c -o app.o
"$cc" -std=c11 -O2 -Wall -Wextra -pedantic -I. $platform_flags -c mongoose.c -o mongoose.o
"$cc" -std=c11 -O2 -w -I. $platform_flags -c sqlite3.c -o sqlite3.o
"$cc" -std=c11 -O2 -Wall -Wextra -pedantic -I. $platform_flags -c cJSON.c -o cJSON.o
"$cc" app.o mongoose.o sqlite3.o cJSON.o -o dashboard_server $libs

echo "Built dashboard_server"
