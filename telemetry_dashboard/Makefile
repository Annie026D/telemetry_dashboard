# Cross-platform GNU Make build for Linux/WSL and native MSYS2 MinGW/UCRT64.
# MSYS2 exports OS=Windows_NT; an explicit PLATFORM=windows|unix override is
# also supported for cross-compilers and CI.
# GNU Make supplies a built-in CC=cc, so use gcc explicitly. A command-line
# override such as `make CC=clang` still takes precedence.
CC := gcc
# Allow callers to choose the Python interpreter used by validation scripts, while defaulting to Python 3.
PYTHON ?= python3
# Start with automatic platform detection unless a caller explicitly selects Windows or Unix behavior.
PLATFORM ?= auto

# Resolve the automatic platform choice from the operating-system value supplied to GNU Make.
ifeq ($(PLATFORM),auto)
  # Treat the Windows_NT marker exported by MSYS2 as a native Windows build.
  ifeq ($(OS),Windows_NT)
    # Select Windows compiler definitions, output naming, and libraries.
    PLATFORM := windows
  else
    # Treat all other environments, including Linux and WSL, as Unix builds.
    PLATFORM := unix
  endif
endif

# Apply the common C language version, optimization, warning, and local-header search settings to project compilation.
COMMON_CFLAGS := -std=c11 -O2 -Wall -Wextra -pedantic -I.

# Select platform-specific compiler definitions, output names, libraries, and analyzer support.
ifeq ($(PLATFORM),windows)
  # Tell Mongoose to use Win32 APIs and expose the minimum required Windows API level.
  ARCH_CFLAGS := -DMG_ARCH=MG_ARCH_WIN32 -D_WIN32_WINNT=0x0601
  # Name the Windows executable with the conventional .exe extension.
  TARGET := dashboard_server.exe
  # Link Winsock because the telemetry server uses UDP and HTTP networking.
  LIBS := -lws2_32
  # Leave GCC's Unix-oriented static analyzer disabled for this Windows configuration.
  ANALYZER_FLAGS :=
else ifeq ($(PLATFORM),unix)
  # Expose the POSIX interfaces used by the application and select Mongoose's Unix implementation.
  ARCH_CFLAGS := -D_DEFAULT_SOURCE -D_POSIX_C_SOURCE=200809L \
	-DMG_ARCH=MG_ARCH_UNIX
  # Use the extension-free executable name customary on Linux and WSL.
  TARGET := dashboard_server
  # Link thread, dynamic-loading, and mathematics support required by the server and its dependencies.
  LIBS := -lpthread -ldl -lm
  # Enable GCC's static analyzer during the dedicated compliance check on Unix builds.
  ANALYZER_FLAGS := -fanalyzer
else
  # Stop immediately when the requested platform is unknown because safe compiler and linker options cannot be selected.
  $(error Unsupported PLATFORM='$(PLATFORM)'; use windows or unix)
endif

# Combine shared and platform-specific flags for normal project compilation.
CFLAGS := $(COMMON_CFLAGS) $(ARCH_CFLAGS)
# Add stricter conversion, formatting, prototype, pointer, and error checks for the project-owned application source.
APP_CFLAGS := $(CFLAGS) -Wconversion -Wsign-conversion -Wshadow -Wformat=2 \
	-Wundef -Wstrict-prototypes -Wmissing-prototypes -Wcast-qual \
	-Wwrite-strings -Wnull-dereference -Werror
# Compile vendored SQLite quietly because third-party warnings are outside the project's comment and warning policy.
SQLITE_CFLAGS := -std=c11 -O2 -w -I. $(ARCH_CFLAGS)
# List every object that must be linked to produce the telemetry dashboard server.
OBJS := app.o mongoose.o sqlite3.o cJSON.o

# Declare command-style targets so files with the same names cannot prevent their recipes from running.
.PHONY: all clean compliance-check print-config

# Build the complete server when GNU Make is invoked without a specific target.
all: $(TARGET)

# Relink the executable whenever any application or library object has changed.
$(TARGET): $(OBJS)
	# Invoke the selected C compiler as a linker and include the platform networking and threading libraries.
	$(CC) $(OBJS) -o $@ $(LIBS)

# Recompile the project-owned backend whenever its source or any directly included public header changes.
app.o: app.c mongoose.h sqlite3.h cJSON.h
	# Apply the strict project warning policy while converting app.c into its object file.
	$(CC) $(APP_CFLAGS) -c $< -o $@

# Recompile the vendored Mongoose networking implementation when its source or header changes.
mongoose.o: mongoose.c mongoose.h
	# Compile Mongoose with normal cross-platform flags because it is third-party code.
	$(CC) $(CFLAGS) -c $< -o $@

# Recompile the vendored SQLite database implementation when its source or header changes.
sqlite3.o: sqlite3.c sqlite3.h
	# Suppress third-party warnings while producing the SQLite object used for persistence.
	$(CC) $(SQLITE_CFLAGS) -c $< -o $@

# Recompile the vendored cJSON parser when its source or header changes.
cJSON.o: cJSON.c cJSON.h
	# Compile cJSON with the shared platform flags so JSON parsing matches the target environment.
	$(CC) $(CFLAGS) -c $< -o $@

# Run compiler and policy checks without producing a new executable.
compliance-check:
	# Validate app.c with the same strict flags used for its production object.
	$(CC) $(APP_CFLAGS) -fsyntax-only app.c
	# Run the compiler's deeper static analysis where the selected platform supports it.
	$(CC) -std=c11 -O0 -Wall -Wextra -pedantic $(ANALYZER_FLAGS) \
		-I. $(ARCH_CFLAGS) -fsyntax-only app.c
	# Enforce source-level backend safety rules that do not require a working C compiler.
	$(PYTHON) scripts/check_backend_policy.py
	# Confirm that the checked-in schema and the schema embedded in app.c remain synchronized.
	$(PYTHON) scripts/check_master_schema.py

# Print resolved build settings to make platform and toolchain troubleshooting straightforward.
print-config:
	# Show the selected platform after automatic detection or caller override.
	@echo PLATFORM=$(PLATFORM)
	# Show the executable filename that this build will produce.
	@echo TARGET=$(TARGET)
	# Show the platform-specific compiler definitions applied to source files.
	@echo ARCH_CFLAGS=$(ARCH_CFLAGS)
	# Show the operating-system libraries included during final linking.
	@echo LIBS=$(LIBS)

# Remove only the known compiler outputs so source, configuration, databases, and logs remain untouched.
clean:
	# Delete the two supported executable names and the explicitly listed object files.
	rm -f dashboard_server dashboard_server.exe $(OBJS)
