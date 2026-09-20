// Command sidecar runs a single Xray-core instance in-process with telemetry hooks
// and a fault-injecting dialer installed, and exposes both over a loopback control
// plane for the Electron UI.
//
// ONE INSTANCE PER PROCESS, ALWAYS. core.New() unconditionally overwrites the
// package-level dnsClient and outbound manager in transport/internet, so two
// instances in one process silently cross-talk; and the burst observatory's probe
// timers outlive an in-process reload and later fire against a config that is gone.
// Reload therefore means: kill this process, spawn a new one.
package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/xtls/xray-core/core"

	"xraystudio/sidecar/control"
	"xraystudio/sidecar/instance"
	"xraystudio/sidecar/trace"

	_ "xraystudio/sidecar/internal/xraydeps"
)

// patchCount is the number of telemetry patches this binary expects to have been
// built against. Reported in the ready line so the UI can refuse to show a decision
// funnel it cannot actually populate.
const patchCount = 8

func main() {
	var (
		showVersion = flag.Bool("version", false, "print the linked Xray-core version and exit")
		configPath  = flag.String("config", "", "config to load and start immediately")
		assetDir    = flag.String("assets", "", "directory holding geoip.dat / geosite.dat for --config")
		queueSize   = flag.Int("queue", trace.DefaultQueueSize, "event queue size")
		idleTimeout = flag.Duration("idle-timeout", 0, "exit if no control client connects within this period (0 = never)")
	)
	flag.Parse()

	if *showVersion {
		fmt.Println(core.VersionStatement()[0])
		return
	}

	bus := trace.NewBus(*queueSize)
	bus.StartStatsTicker(500 * time.Millisecond)
	defer bus.Close()

	// Where redirected logs go. The app passes its own data directory, which on the
	// portable Windows build sits next to the executable — so a redirect never writes
	// outside the folder the user unpacked.
	logDir := os.Getenv("XRAYSTUDIO_LOG_DIR")
	if logDir == "" {
		logDir = filepath.Join(os.TempDir(), "xray-studio-logs")
	}
	mgr := instance.New(bus, logDir)
	defer mgr.Close()

	srv, err := control.New(mgr, bus)
	if err != nil {
		fatal("cannot bind control plane: %v", err)
	}
	defer srv.Close()

	// The parent reads this line to learn the port and token. It must be the first
	// thing on stdout and must be exactly one line — everything after it is the
	// core's own log output, shown verbatim in the UI.
	fmt.Println(srv.ReadyLine(core.Version(), patchCount))
	os.Stdout.Sync()

	go func() {
		if err := srv.Serve(); err != nil {
			fatal("control plane: %v", err)
		}
	}()

	if *configPath != "" {
		raw, err := os.ReadFile(*configPath)
		if err != nil {
			fatal("read config: %v", err)
		}
		if err := mgr.Start(raw, *configPath, *assetDir); err != nil {
			// Not fatal: the UI wants to display the error and let the user fix the
			// config, which is the entire point of the tool.
			warn("start failed: %v", err)
		}
	}

	if *idleTimeout > 0 {
		go watchIdle(srv, *idleTimeout)
	}

	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}

// watchIdle terminates the sidecar if the UI never shows up. Without it, a crashed
// Electron process would leave an orphan holding the user's proxy ports open.
func watchIdle(srv *control.Server, d time.Duration) {
	time.Sleep(d)
	if srv.Connections() == 0 {
		warn("no control client after %s, exiting", d)
		os.Exit(0)
	}
}

func fatal(format string, args ...any) {
	emit("fatal", fmt.Sprintf(format, args...))
	os.Exit(1)
}

func warn(format string, args ...any) {
	emit("warn", fmt.Sprintf(format, args...))
}

// emit writes a structured line to stderr, so the parent can distinguish sidecar
// diagnostics from the Xray log stream on stdout.
func emit(level, msg string) {
	b, _ := json.Marshal(map[string]string{"level": level, "msg": msg})
	fmt.Fprintln(os.Stderr, string(b))
}
