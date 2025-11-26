# "Detach" vs "Shutdown" Technical Design

## I. Core Concept Definitions

### 1.1 Detach
**Definition**: User disconnects from the tmux session, but **the orchestrator daemon and all services continue running**.

**Characteristics**:
- ✅ Tmux session continues to exist
- ✅ Orchestrator daemon continues running
- ✅ IPC Server continues listening
- ✅ Panel supervisors continue monitoring and restarting panels
- ✅ Other users can continue to attach and use
- ✅ State synchronization and collaboration features remain functional

**Triggered by**:
- `Ctrl+b d` (tmux standard detach)
- Closing the terminal window (SIGHUP is already ignored)
- `tmuxcoder detach` command (explicit detach)

### 1.2 Shutdown
**Definition**: Completely stop the orchestrator daemon, with optional tmux session destruction.

**Categories**:

#### A. Graceful Shutdown (Session Preserved)
```bash
tmuxcoder stop [session-name]
```
- ❌ Orchestrator daemon stops
- ❌ IPC Server closes
- ❌ Panel supervisors stop
- ✅ Tmux session remains (panels still running but no longer supervised)
- ⚠️ Full restart required to restore management functionality

#### B. Full Cleanup
```bash
tmuxcoder stop --cleanup [session-name]
```
- ❌ Orchestrator daemon stops
- ❌ IPC Server closes
- ❌ Panel supervisors stop
- ❌ Tmux session destroyed
- ❌ All panel processes terminated

---

## II. Current State Analysis

### 2.1 Already Implemented Features
Based on [main.go:2038-2042](cmd/opencode-tmux/main.go#L2038-L2042) and [main.go:260-266](cmd/opencode-tmux/main.go#L260-L266):

✅ **Implemented**:
1. `SIGHUP` ignored - daemon won't exit when parent shell closes
2. `cleanupSession` flag - controls whether to kill tmux session on `Stop()`
3. `Shutdown(cleanup bool)` IPC interface - [orchestrator.go:8-10](internal/interfaces/orchestrator.go#L8-L10)
4. Signal handling (`SIGTERM`/`SIGINT`) - [main.go:1794](cmd/opencode-tmux/main.go#L1794)

### 2.2 Current Problems

❌ **Missing Features**:
1. **No client connection tracking** - Cannot distinguish "last user detach" from "one user detach"
2. **User detach triggers shutdown** - Current `Ctrl+C` triggers `Stop()`
3. **No explicit detach command** - Users can only use `Ctrl+b d`
4. **No permission control** - Anyone with IPC socket access can shutdown
5. **Missing CLI subcommands** - Need `start/attach/detach/stop/status` subcommands

---

## III. Technical Design

### 3.1 Client Connection Tracking

#### 3.1.1 Tmux Client Detection
Use tmux built-in command `list-clients` to detect current connections:

```bash
# Check number of clients for specified session
tmux list-clients -t <session-name> | wc -l

# Get detailed client information (TTY, PID, connection time, etc.)
tmux list-clients -t <session-name> -F "#{client_tty} #{client_pid} #{client_created}"
```

#### 3.1.2 Implement `ClientTracker` Component

Add to `TmuxOrchestrator`:

```go
type ClientTracker struct {
    sessionName  string
    tmuxCommand  string
    checkInterval time.Duration

    mu           sync.RWMutex
    clientCount  int
    lastCheck    time.Time
}

// GetConnectedClients returns the number of currently connected clients
func (ct *ClientTracker) GetConnectedClients() (int, error) {
    cmd := exec.Command(ct.tmuxCommand, "list-clients", "-t", ct.sessionName)
    output, err := cmd.Output()
    if err != nil {
        // Session doesn't exist or has no clients
        return 0, err
    }

    lines := strings.Split(strings.TrimSpace(string(output)), "\n")
    count := 0
    for _, line := range lines {
        if strings.TrimSpace(line) != "" {
            count++
        }
    }

    return count, nil
}

// MonitorClients periodically checks client connection status (optional)
func (ct *ClientTracker) MonitorClients(ctx context.Context, callback func(count int)) {
    ticker := time.NewTicker(ct.checkInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            count, err := ct.GetConnectedClients()
            if err == nil {
                ct.mu.Lock()
                ct.clientCount = count
                ct.lastCheck = time.Now()
                ct.mu.Unlock()

                if callback != nil {
                    callback(count)
                }
            }
        }
    }
}

// GetLastKnownCount returns the last checked client count (no wait)
func (ct *ClientTracker) GetLastKnownCount() (int, time.Time) {
    ct.mu.RLock()
    defer ct.mu.RUnlock()
    return ct.clientCount, ct.lastCheck
}
```

#### 3.1.3 Integration into `TmuxOrchestrator`

```go
type TmuxOrchestrator struct {
    // ... existing fields ...

    clientTracker *ClientTracker

    // Configuration options
    autoShutdownWhenEmpty bool  // Auto shutdown when all clients disconnect (default false)
}

// Start client monitoring in Start()
func (orch *TmuxOrchestrator) Start() error {
    // ... existing initialization ...

    if orch.clientTracker != nil {
        go orch.clientTracker.MonitorClients(orch.ctx, func(count int) {
            log.Printf("Connected clients: %d", count)

            if orch.autoShutdownWhenEmpty && count == 0 {
                log.Printf("All clients disconnected, triggering auto-shutdown")
                orch.triggerShutdown(false, "all clients disconnected")
            }
        })
    }

    return nil
}
```

---

### 3.2 Signal Handling Refactoring

#### 3.2.1 Current Problem
[main.go:1792-1805](cmd/opencode-tmux/main.go#L1792-L1805) `waitForShutdown()` directly triggers `Stop()` on `SIGTERM`/`SIGINT`.

This is inappropriate in **daemon mode**:
- User pressing `Ctrl+C` should only detach, not shutdown daemon
- Only explicit `tmuxcoder stop` command should shutdown

#### 3.2.2 Improvement Plan

**Distinguish Run Modes**:

```go
type RunMode int

const (
    ModeForeground RunMode = iota  // Foreground mode: Ctrl+C triggers cleanup shutdown
    ModeDaemon                      // Daemon mode: Ctrl+C ignored (or detach only), needs IPC shutdown
)

type TmuxOrchestrator struct {
    // ... existing fields ...

    runMode RunMode
}
```

**Refactor `waitForShutdown()`**:

```go
func (orch *TmuxOrchestrator) waitForShutdown() {
    sigChan := make(chan os.Signal, 1)

    switch orch.runMode {
    case ModeForeground:
        // Foreground mode: respond to SIGTERM/SIGINT, trigger cleanup shutdown
        signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
        defer signal.Stop(sigChan)

        select {
        case sig := <-sigChan:
            log.Printf("Foreground mode: received %s, triggering cleanup shutdown", sig)
            orch.triggerShutdown(true, fmt.Sprintf("signal %s", sig))
        case <-orch.shutdownChan:
            log.Printf("Shutdown requested programmatically")
        case <-orch.ctx.Done():
            log.Printf("Shutdown triggered via context cancel")
        }

    case ModeDaemon:
        // Daemon mode: ignore SIGTERM/SIGINT (or log), only respond to IPC shutdown
        signal.Notify(sigChan, syscall.SIGTERM, syscall.SIGINT)
        defer signal.Stop(sigChan)

        for {
            select {
            case sig := <-sigChan:
                log.Printf("Daemon mode: received %s (ignored, use 'tmuxcoder stop' to shutdown)", sig)
                // Optional: check if clients connected, output hint if so
                if orch.clientTracker != nil {
                    count, _ := orch.clientTracker.GetConnectedClients()
                    if count > 0 {
                        log.Printf("  → %d client(s) still connected", count)
                    }
                }

            case <-orch.shutdownChan:
                log.Printf("Daemon shutdown requested via IPC")
                return

            case <-orch.ctx.Done():
                log.Printf("Daemon shutdown via context cancel")
                return
            }
        }
    }
}
```

---

### 3.3 CLI Subcommand Design

#### 3.3.1 Command Structure

```
tmuxcoder <subcommand> [options] [session-name]

Subcommands:
  start      Start orchestrator daemon and tmux session
  attach     Connect to existing tmux session
  detach     Explicitly disconnect current connection (keep daemon running)
  stop       Stop orchestrator daemon
  status     View session status
  list       List all running sessions
```

#### 3.3.2 Detailed Command Specifications

**A. `tmuxcoder start [session-name] [flags]`**

Start orchestrator daemon and tmux session.

```bash
# Start daemon and attach (default behavior)
tmuxcoder start my-session

# Start daemon but don't attach (server-only mode)
tmuxcoder start my-session --server-only

# Run in foreground (for debugging)
tmuxcoder start my-session --foreground

# Force create new session (delete if exists)
tmuxcoder start my-session --force-new

# Reuse existing session
tmuxcoder start my-session --reuse

# Custom config file
tmuxcoder start my-session --config ./custom-tmux.yaml
```

**Flags**:
- `--server-only`: Start daemon without attaching, main process exits immediately
- `--foreground`: Foreground mode, Ctrl+C triggers cleanup shutdown
- `--daemon`: Daemon mode (default), Ctrl+C ignored
- `--force-new`: Force create new session
- `--reuse`: Reuse existing session
- `--config <path>`: Specify config file
- `--auto-shutdown-when-empty`: Auto shutdown when all clients disconnect

**Behavior**:
1. Check if session exists (via PID file and tmux `has-session`)
2. If exists and `--reuse` specified, reuse; otherwise error or force delete
3. Create/configure tmux session
4. Start orchestrator daemon (unless `--foreground`)
5. If not `--server-only`, attach to session

---

**B. `tmuxcoder attach [session-name]`**

Connect to running tmux session.

```bash
# Attach to default session
tmuxcoder attach

# Attach to specified session
tmuxcoder attach my-session

# Read-only attach (tmux -r)
tmuxcoder attach my-session --read-only
```

**Behavior**:
1. Check if session exists (`tmux has-session`)
2. Check if orchestrator daemon is running (PID file + IPC socket)
3. If daemon not running but session exists, prompt user
4. Execute `tmux attach-session -t <session-name>`

**Note**: This command **does not start daemon**, only connects to existing session.

---

**C. `tmuxcoder detach [session-name]`**

Explicitly disconnect current connection (graceful detach).

```bash
# Detach current session
tmuxcoder detach

# Detach all clients of specified session
tmuxcoder detach my-session --all
```

**Behavior**:
1. If inside tmux session, execute `tmux detach-client`
2. If `--all` specified, detach all clients of that session
3. **Does not trigger daemon shutdown**, daemon continues running

**Use Cases**:
- User wants to leave gracefully instead of closing terminal
- Need explicit detach in scripts

---

**D. `tmuxcoder stop [session-name] [flags]`**

Stop orchestrator daemon.

```bash
# Stop daemon, preserve tmux session
tmuxcoder stop my-session

# Stop daemon and destroy tmux session
tmuxcoder stop my-session --cleanup

# Check client connections, refuse if connected
tmuxcoder stop my-session --check-clients

# Force stop (ignore client connections)
tmuxcoder stop my-session --force
```

**Flags**:
- `--cleanup`: Also destroy tmux session
- `--check-clients`: If clients connected, refuse to stop (needs `--force`)
- `--force`: Force stop even if clients connected

**Behavior**:
1. Check if orchestrator daemon is running (PID file + IPC socket)
2. If `--check-clients` specified, check client connection count
   - If connected and `--force` not specified, show error and exit
   - Example output:
     ```
     Error: 2 client(s) still connected to session 'my-session'
     Use --force to stop anyway, or ask other users to detach first.

     Connected clients:
       - /dev/ttys001 (PID 12345, connected 5m ago)
       - /dev/ttys002 (PID 12346, connected 2m ago)
     ```
3. Send `Shutdown(cleanup)` command via IPC
4. Wait for daemon exit (timeout 10s)
5. If timeout, force terminate with `SIGTERM`

---

**E. `tmuxcoder status [session-name]`**

View session status.

```bash
# View default session status
tmuxcoder status

# View specified session status
tmuxcoder status my-session

# JSON format output
tmuxcoder status my-session --json
```

**Example Output**:
```
Session: my-session
Status: Running
Daemon: Running (PID 12345)
Clients: 2 connected
  - /dev/ttys001 (PID 12346, connected 5m ago)
  - /dev/ttys002 (PID 12347, connected 2m ago)
Panels:
  - sessions: Running (PID 12348)
  - messages: Running (PID 12349)
  - input: Running (PID 12350)
IPC Socket: /tmp/tmuxcoder/my-session.sock
Config: /path/to/tmux.yaml
Uptime: 1h 23m
```

---

**F. `tmuxcoder list`**

List all running sessions.

```bash
# List all sessions
tmuxcoder list

# Quiet mode (only show names)
tmuxcoder list --quiet
```

**Example Output**:
```
NAME          STATUS    DAEMON    CLIENTS  UPTIME
my-session    Running   Running   2        1h 23m
test-session  Running   Running   0        5m 12s
old-session   Orphaned  Stopped   1        2d 5h
```

**Note**:
- `Orphaned` status means tmux session exists but daemon is not running
- Can reclaim with `tmuxcoder start --reuse <orphaned-session>`

---

### 3.4 IPC Protocol Extensions

#### 3.4.1 Current IPC Interface

[orchestrator.go:3-11](internal/interfaces/orchestrator.go#L3-L11):
```go
type OrchestratorControl interface {
    ReloadLayout() error
    Shutdown(cleanup bool) error
}
```

#### 3.4.2 Extended Interface

```go
type OrchestratorControl interface {
    // Existing methods
    ReloadLayout() error
    Shutdown(cleanup bool) error

    // New methods
    GetStatus() (*SessionStatus, error)
    GetConnectedClients() ([]ClientInfo, error)
    Ping() error
}

type SessionStatus struct {
    SessionName   string        `json:"session_name"`
    DaemonPID     int           `json:"daemon_pid"`
    IsRunning     bool          `json:"is_running"`
    Uptime        time.Duration `json:"uptime"`
    ClientCount   int           `json:"client_count"`
    Panels        []PanelStatus `json:"panels"`
    SocketPath    string        `json:"socket_path"`
    ConfigPath    string        `json:"config_path"`
}

type PanelStatus struct {
    Name      string `json:"name"`
    IsRunning bool   `json:"is_running"`
    PID       int    `json:"pid,omitempty"`
    Restarts  int    `json:"restarts"`
}

type ClientInfo struct {
    TTY           string    `json:"tty"`
    PID           int       `json:"pid"`
    ConnectedAt   time.Time `json:"connected_at"`
    SessionName   string    `json:"session_name"`
}
```

---

### 3.5 Permission Control

#### 3.5.1 Problem Analysis

Currently any process with IPC socket access can send `Shutdown` command, which is a security risk.

#### 3.5.2 Multi-Layer Permission Control

**Level 1: Filesystem Permissions (Existing)**

- IPC socket file permissions (`0600` or `0660`)
- Restrict access via socket file owner/group

**Level 2: Session Owner Validation (New)**

Record session owner in `TmuxOrchestrator`:

```go
type TmuxOrchestrator struct {
    // ... existing fields ...

    sessionOwner SessionOwner
}

type SessionOwner struct {
    UID      uint32    `json:"uid"`
    GID      uint32    `json:"gid"`
    Username string    `json:"username"`
    Hostname string    `json:"hostname"`
    StartedAt time.Time `json:"started_at"`
}

// Record on Start()
func (orch *TmuxOrchestrator) Start() error {
    orch.sessionOwner = SessionOwner{
        UID:       uint32(os.Getuid()),
        GID:       uint32(os.Getgid()),
        Username:  os.Getenv("USER"),
        Hostname:  getHostname(),
        StartedAt: time.Now(),
    }
    // ...
}
```

**Level 3: Command Permission Checks (New)**

Verify permissions when handling sensitive IPC commands:

```go
// Permission check when implementing Shutdown()
func (orch *TmuxOrchestrator) Shutdown(cleanup bool, requester *IpcRequester) error {
    // 1. Check if requester is session owner
    if requester.UID != orch.sessionOwner.UID {
        log.Printf("Shutdown denied: requester UID %d != owner UID %d",
                   requester.UID, orch.sessionOwner.UID)
        return fmt.Errorf("permission denied: only session owner can shutdown")
    }

    // 2. If cleanup=true, additional check for other client connections
    if cleanup {
        clients, err := orch.clientTracker.GetConnectedClients()
        if err == nil && clients > 1 {
            return fmt.Errorf("cannot cleanup: %d other client(s) still connected", clients-1)
        }
    }

    // 3. Execute shutdown
    orch.triggerShutdown(cleanup, fmt.Sprintf("IPC shutdown by %s", requester.Username))
    return nil
}
```

**Level 4: Configurable Permission Policy (Optional)**

Allow permission policy configuration in `tmux.yaml`:

```yaml
permissions:
  # Who can shutdown (owner, group, any)
  shutdown: owner

  # Who can reload layout
  reload_layout: group

  # Who can view status
  status: any

  # Allowed UID list (whitelist)
  allowed_users:
    - 1000
    - 1001
```

#### 3.5.3 IPC Requester Identification

Identify requester identity in IPC server:

```go
// internal/ipc/socket_server.go

type IpcRequester struct {
    UID      uint32
    GID      uint32
    Username string
    Hostname string
    PID      int
}

// Extract peer credentials from Unix socket connection
func getRequesterFromConn(conn net.Conn) (*IpcRequester, error) {
    unixConn, ok := conn.(*net.UnixConn)
    if !ok {
        return nil, fmt.Errorf("not a unix socket connection")
    }

    // Use SCM_CREDENTIALS to get peer process UID/GID/PID
    file, err := unixConn.File()
    if err != nil {
        return nil, err
    }
    defer file.Close()

    ucred, err := syscall.GetsockoptUcred(int(file.Fd()),
                                           syscall.SOL_SOCKET,
                                           syscall.SO_PEERCRED)
    if err != nil {
        return nil, err
    }

    user, _ := user.LookupId(fmt.Sprintf("%d", ucred.Uid))
    username := ""
    if user != nil {
        username = user.Username
    }

    hostname, _ := os.Hostname()

    return &IpcRequester{
        UID:      ucred.Uid,
        GID:      ucred.Gid,
        PID:      int(ucred.Pid),
        Username: username,
        Hostname: hostname,
    }, nil
}
```

---

## IV. Process Supervision and Resource Cleanup

### 4.1 Process Supervision

#### 4.1.1 Current Supervision Mechanism

Based on code analysis, basic panel process supervision exists:

**A. Pane Supervisor** ([main.go:1367-1415](cmd/opencode-tmux/main.go#L1367-L1415))
```go
// Each pane has independent supervisor goroutine
func (orch *TmuxOrchestrator) monitorPane(ctx context.Context, paneTarget, appName string, envVars map[string]string) {
    ticker := time.NewTicker(2 * time.Second)  // Check every 2 seconds
    // ...
    alive, err := orch.isPaneAlive(paneTarget)
    if !alive {
        // Auto restart with exponential backoff
    }
}
```

**B. Tmux Session Watcher** ([main.go:1826-1846](cmd/opencode-tmux/main.go#L1826-L1846))
```go
// Monitor if tmux session exists
func (orch *TmuxOrchestrator) watchTmuxSession() {
    // Check every 1 second
    cmd := exec.Command(orch.tmuxCommand, "has-session", "-t", orch.sessionName)
    if err := cmd.Run(); err != nil {
        // Session vanished, trigger shutdown
        orch.triggerShutdown(false, "tmux session vanished")
    }
}
```

#### 4.1.2 Enhanced Supervision Scenarios

Under the new **detach/shutdown separation** design, process supervision needs to handle:

##### Scenario 1: Daemon Stops but Tmux Session Remains

**Problem**:
- `tmuxcoder stop` (without `--cleanup`) stops daemon
- Pane supervisors stop, but panel processes still running
- If a panel crashes, it won't auto-restart
- User may see dead panes when reattaching

**Solution**: Graceful handling in `Stop()`

```go
func (orch *TmuxOrchestrator) Stop() error {
    log.Printf("Stopping tmux orchestrator...")

    orch.isRunning = false

    // Cancel all supervisors
    orch.paneSupervisorMu.Lock()
    for paneTarget, cancel := range orch.paneSupervisors {
        log.Printf("Stopping supervisor for pane %s", paneTarget)
        cancel()
    }
    orch.paneSupervisors = map[string]context.CancelFunc{}
    orch.paneSupervisorMu.Unlock()

    // Stop sync manager
    if orch.syncManager != nil {
        orch.syncManager.Stop()
    }

    // Stop IPC server
    if orch.ipcServer != nil {
        orch.ipcServer.Stop()
    }

    // Decide whether to kill session based on cleanup flag
    if orch.shouldCleanupOnExit() {
        if err := orch.killTmuxSession(); err != nil {
            log.Printf("Failed to kill tmux session: %v", err)
        }
    } else {
        log.Printf("Daemon stopped, session %s remains available", orch.sessionName)
        log.Printf("WARNING: Panel processes are no longer supervised")
        log.Printf("  → To resume management: tmuxcoder start %s --reuse", orch.sessionName)
        log.Printf("  → To destroy session:   tmuxcoder stop %s --cleanup", orch.sessionName)

        // Optional: display warning in tmux status bar
        orch.setTmuxStatusBarWarning("⚠ Daemon stopped - panels unsupervised")
    }

    // Cleanup socket file
    if err := os.Remove(orch.socketPath); err != nil && !os.IsNotExist(err) {
        log.Printf("Failed to remove socket file: %v", err)
    }

    log.Printf("Tmux orchestrator stopped")
    return nil
}

// Display warning message in tmux status bar
func (orch *TmuxOrchestrator) setTmuxStatusBarWarning(message string) {
    cmd := exec.Command(orch.tmuxCommand, "set", "-t", orch.sessionName,
                       "status-right",
                       fmt.Sprintf("#[fg=yellow,bold]%s", message))
    if err := cmd.Run(); err != nil {
        log.Printf("Failed to set status bar warning: %v", err)
    }
}
```

##### Scenario 2: Daemon Reclaims Orphaned Session

**Problem**:
- User runs `tmuxcoder start my-session --reuse`
- Panels in session may be in various states:
  - Running normally
  - Crashed
  - Zombie processes
  - Stale environment variables (OPENCODE_SOCKET points to old socket)

**Solution**: Smart restart strategy

```go
// Enhanced checking in prepareExistingSession()
func (orch *TmuxOrchestrator) prepareExistingSession() error {
    log.Printf("Reusing existing tmux session: %s", orch.sessionName)

    // 1. Check health status of all panes
    paneHealth := orch.checkAllPanesHealth()

    // 2. Determine strategy based on health status
    for paneTarget, status := range paneHealth {
        switch status {
        case PaneHealthy:
            log.Printf("Pane %s is healthy, checking if needs env update", paneTarget)
            if orch.needsEnvUpdate(paneTarget) {
                log.Printf("Pane %s has stale environment, restarting", paneTarget)
                orch.restartPane(paneTarget)
            } else {
                log.Printf("Pane %s is healthy, leaving it running", paneTarget)
            }

        case PaneDead:
            log.Printf("Pane %s is dead, will be restarted by supervisor", paneTarget)
            // Supervisor will auto-restart

        case PaneZombie:
            log.Printf("Pane %s is zombie, killing and restarting", paneTarget)
            orch.killZombiePane(paneTarget)

        case PaneMissing:
            log.Printf("Pane %s does not exist, will be created", paneTarget)
            // Will be created later
        }
    }

    // 3. Restore tmux persistence options
    orch.applyTmuxPersistenceOptions()

    return nil
}

// Check process environment variables in pane
func (orch *TmuxOrchestrator) needsEnvUpdate(paneTarget string) bool {
    // Get PID of process running in pane
    cmd := exec.Command(orch.tmuxCommand, "display-message", "-p", "-t", paneTarget, "#{pane_pid}")
    output, err := cmd.Output()
    if err != nil {
        return true // Cannot get, assume needs update
    }

    pid := strings.TrimSpace(string(output))
    if pid == "" {
        return true
    }

    // Read process environment variables (from /proc/<pid>/environ)
    environPath := fmt.Sprintf("/proc/%s/environ", pid)
    data, err := os.ReadFile(environPath)
    if err != nil {
        // macOS doesn't support /proc, try other method
        return orch.needsEnvUpdateMacOS(pid)
    }

    // Check if OPENCODE_SOCKET points to current socket
    environ := strings.Split(string(data), "\x00")
    for _, env := range environ {
        if strings.HasPrefix(env, "OPENCODE_SOCKET=") {
            socketPath := strings.TrimPrefix(env, "OPENCODE_SOCKET=")
            if socketPath != orch.socketPath {
                log.Printf("Pane %s has stale socket: %s (expected: %s)",
                          paneTarget, socketPath, orch.socketPath)
                return true
            }
            return false // Socket correct
        }
    }

    return true // OPENCODE_SOCKET not found, needs update
}

// Check environment variables via ps on macOS
func (orch *TmuxOrchestrator) needsEnvUpdateMacOS(pid string) bool {
    cmd := exec.Command("ps", "eww", "-p", pid)
    output, err := cmd.Output()
    if err != nil {
        return true
    }

    // Parse ps output to find OPENCODE_SOCKET
    outputStr := string(output)
    if strings.Contains(outputStr, "OPENCODE_SOCKET="+orch.socketPath) {
        return false
    }

    return true
}

// Health status enumeration
type PaneHealth int

const (
    PaneHealthy PaneHealth = iota
    PaneDead
    PaneZombie
    PaneMissing
)

// Check health status of all panes
func (orch *TmuxOrchestrator) checkAllPanesHealth() map[string]PaneHealth {
    result := make(map[string]PaneHealth)

    orch.layoutMutex.RLock()
    panes := make(map[string]string)
    for pType, pTarget := range orch.panes {
        panes[pType] = pTarget
    }
    orch.layoutMutex.RUnlock()

    for _, paneTarget := range panes {
        result[paneTarget] = orch.checkPaneHealth(paneTarget)
    }

    return result
}

// Check health status of single pane
func (orch *TmuxOrchestrator) checkPaneHealth(paneTarget string) PaneHealth {
    // Check if pane exists
    cmd := exec.Command(orch.tmuxCommand, "list-panes", "-t", orch.sessionName, "-F", "#{pane_id}")
    output, err := cmd.Output()
    if err != nil {
        return PaneMissing
    }

    paneIDs := strings.Split(strings.TrimSpace(string(output)), "\n")
    found := false
    for _, id := range paneIDs {
        if strings.TrimSpace(id) == paneTarget {
            found = true
            break
        }
    }
    if !found {
        return PaneMissing
    }

    // Check pane_dead flag
    cmd = exec.Command(orch.tmuxCommand, "display-message", "-p", "-t", paneTarget, "#{pane_dead}")
    output, err = cmd.Output()
    if err != nil {
        return PaneMissing
    }

    isDead := strings.TrimSpace(string(output)) == "1"
    if isDead {
        return PaneDead
    }

    // Check if zombie process (pane exists but PID invalid)
    cmd = exec.Command(orch.tmuxCommand, "display-message", "-p", "-t", paneTarget, "#{pane_pid}")
    output, err = cmd.Output()
    if err != nil || strings.TrimSpace(string(output)) == "" {
        return PaneZombie
    }

    return PaneHealthy
}
```

---

### 4.2 Socket File Cleanup

#### 4.2.1 Socket Lifecycle Issues

**Current socket cleanup** ([main.go:268-271](cmd/opencode-tmux/main.go#L268-L271), [main.go:604-608](cmd/opencode-tmux/main.go#L604-L608)):

```go
// In Stop()
if err := os.Remove(orch.socketPath); err != nil && !os.IsNotExist(err) {
    log.Printf("Failed to remove socket file: %v", err)
}

// In Start() (before creating new session)
if err := os.Remove(orch.socketPath); err != nil && !os.IsNotExist(err) {
    log.Printf("Warning: failed to remove socket file %s: %v", orch.socketPath, err)
}
```

**Existing Problems**:

1. **Incomplete Stale Socket Detection**
   - Startup only deletes old socket without checking if a process is using it
   - May delete socket in use (if zombie daemon exists)

2. **Socket Leak on Crash**
   - When daemon crashes (kill -9), `Stop()` won't execute
   - Socket file remains, needs manual cleanup

3. **Permission Issues**
   - In multi-user scenarios, socket file permission management unclear
   - May prevent some users from connecting

4. **Concurrent Startup Race**
   - When two users start simultaneously, race condition may occur
   - Need atomic "check-delete-create" operation

#### 4.2.2 Complete Socket Cleanup Solution

##### A. Socket File Status Check

```go
// SocketStatus represents socket file status
type SocketStatus int

const (
    SocketNonExistent SocketStatus = iota  // Doesn't exist
    SocketStale                             // Exists but no process listening (can delete)
    SocketActive                            // Exists and process listening (cannot delete)
    SocketPermissionDenied                  // Exists but no access permission
)

// CheckSocketStatus checks socket file status
func CheckSocketStatus(socketPath string) (SocketStatus, error) {
    // 1. Check if file exists
    info, err := os.Stat(socketPath)
    if err != nil {
        if os.IsNotExist(err) {
            return SocketNonExistent, nil
        }
        if os.IsPermission(err) {
            return SocketPermissionDenied, err
        }
        return SocketNonExistent, err
    }

    // 2. Check if socket file
    if info.Mode()&os.ModeSocket == 0 {
        return SocketNonExistent, fmt.Errorf("%s is not a socket file", socketPath)
    }

    // 3. Try connecting to check if process listening
    conn, err := net.DialTimeout("unix", socketPath, 1*time.Second)
    if err != nil {
        // Connection failed, no process listening (stale socket)
        return SocketStale, nil
    }
    conn.Close()

    // 4. Process listening
    return SocketActive, nil
}

// CleanupStaleSocket cleans up stale socket file
func CleanupStaleSocket(socketPath string) error {
    status, err := CheckSocketStatus(socketPath)
    if err != nil && status != SocketStale {
        return err
    }

    switch status {
    case SocketNonExistent:
        // Doesn't exist, no cleanup needed
        return nil

    case SocketStale:
        // Stale socket, safe to delete
        log.Printf("Removing stale socket file: %s", socketPath)
        if err := os.Remove(socketPath); err != nil && !os.IsNotExist(err) {
            return fmt.Errorf("failed to remove stale socket: %w", err)
        }
        return nil

    case SocketActive:
        // Process using, cannot delete
        return fmt.Errorf("socket %s is in use by another process", socketPath)

    case SocketPermissionDenied:
        // Permission issue
        return fmt.Errorf("permission denied to access socket %s", socketPath)

    default:
        return fmt.Errorf("unknown socket status")
    }
}
```

##### B. Socket Handling on Startup

```go
func (orch *TmuxOrchestrator) Start() error {
    // 1. Create necessary directories
    if err := orch.createDirectories(); err != nil {
        return fmt.Errorf("failed to create directories: %w", err)
    }

    // 2. Check and cleanup socket
    if err := orch.ensureSocketClean(); err != nil {
        return fmt.Errorf("failed to prepare socket: %w", err)
    }

    // 3. Acquire process lock (ensure only one daemon running)
    if err := orch.acquireLock(); err != nil {
        return fmt.Errorf("failed to acquire lock: %w", err)
    }

    // ... rest of startup logic
}

// ensureSocketClean ensures socket file is in usable state
func (orch *TmuxOrchestrator) ensureSocketClean() error {
    status, err := CheckSocketStatus(orch.socketPath)

    switch status {
    case SocketNonExistent:
        // Ideal case, can create directly
        log.Printf("Socket path is clean: %s", orch.socketPath)
        return nil

    case SocketStale:
        // Stale socket, cleanup and continue
        log.Printf("Found stale socket, cleaning up: %s", orch.socketPath)
        if err := CleanupStaleSocket(orch.socketPath); err != nil {
            return fmt.Errorf("failed to cleanup stale socket: %w", err)
        }
        return nil

    case SocketActive:
        // Process using
        if orch.reuseExisting {
            // If reuse mode, try connecting to existing daemon
            log.Printf("Socket is active, attempting to connect to existing daemon")
            return orch.connectToExistingDaemon()
        }

        // Otherwise error
        return fmt.Errorf("another orchestrator is already running with socket %s\n"+
                         "  → To attach to existing session: tmuxcoder attach %s\n"+
                         "  → To stop existing daemon:       tmuxcoder stop %s\n"+
                         "  → To force new session:          tmuxcoder start %s --force-new",
                         orch.socketPath, orch.sessionName, orch.sessionName, orch.sessionName)

    case SocketPermissionDenied:
        return fmt.Errorf("permission denied to access socket %s: %w\n"+
                         "  → Socket may be owned by another user\n"+
                         "  → Check file permissions: ls -l %s",
                         orch.socketPath, err, orch.socketPath)

    default:
        return fmt.Errorf("unknown socket status: %v", err)
    }
}
```

##### C. Socket Cleanup on Stop

```go
func (orch *TmuxOrchestrator) Stop() error {
    log.Printf("Stopping tmux orchestrator...")

    orch.isRunning = false

    // 1. Stop accepting new connections
    if orch.ipcServer != nil {
        log.Printf("Stopping IPC server...")
        orch.ipcServer.Stop()
    }

    // 2. Wait for existing connections to close (max 5s)
    if orch.ipcServer != nil {
        orch.waitForIPCConnectionsClose(5 * time.Second)
    }

    // 3. Cancel all supervisors
    orch.paneSupervisorMu.Lock()
    for paneTarget, cancel := range orch.paneSupervisors {
        log.Printf("Stopping supervisor for pane %s", paneTarget)
        cancel()
    }
    orch.paneSupervisors = map[string]context.CancelFunc{}
    orch.paneSupervisorMu.Unlock()

    // 4. Stop other components
    if orch.syncManager != nil {
        orch.syncManager.Stop()
    }

    // 5. Decide whether to kill session based on cleanup flag
    if orch.shouldCleanupOnExit() {
        if err := orch.killTmuxSession(); err != nil {
            log.Printf("Failed to kill tmux session: %v", err)
        }
    } else {
        log.Printf("Daemon stopped, session %s remains available", orch.sessionName)
        orch.setTmuxStatusBarWarning("⚠ Daemon stopped")
    }

    // 6. Cleanup socket file (critical)
    if err := orch.cleanupSocket(); err != nil {
        log.Printf("Failed to cleanup socket: %v", err)
    }

    // 7. Release lock
    if orch.lock != nil {
        orch.lock.Release()
        orch.lock = nil
    }

    log.Printf("Tmux orchestrator stopped")
    return nil
}

// waitForIPCConnectionsClose waits for all IPC connections to close
func (orch *TmuxOrchestrator) waitForIPCConnectionsClose(timeout time.Duration) {
    if orch.ipcServer == nil {
        return
    }

    deadline := time.Now().Add(timeout)
    ticker := time.NewTicker(100 * time.Millisecond)
    defer ticker.Stop()

    for time.Now().Before(deadline) {
        if orch.ipcServer.ConnectionCount() == 0 {
            log.Printf("All IPC connections closed")
            return
        }

        select {
        case <-ticker.C:
            count := orch.ipcServer.ConnectionCount()
            log.Printf("Waiting for %d IPC connection(s) to close...", count)
        case <-time.After(timeout):
            count := orch.ipcServer.ConnectionCount()
            log.Printf("Timeout waiting for IPC connections, %d still active", count)
            return
        }
    }

    count := orch.ipcServer.ConnectionCount()
    if count > 0 {
        log.Printf("Warning: %d IPC connection(s) still active after timeout", count)
    }
}

// cleanupSocket cleans up socket file
func (orch *TmuxOrchestrator) cleanupSocket() error {
    if orch.socketPath == "" {
        return nil
    }

    // 1. Check socket status
    status, err := CheckSocketStatus(orch.socketPath)
    if err != nil && status != SocketStale && status != SocketNonExistent {
        log.Printf("Failed to check socket status: %v", err)
        // Continue trying to delete
    }

    // 2. Delete socket file
    if err := os.Remove(orch.socketPath); err != nil {
        if os.IsNotExist(err) {
            log.Printf("Socket file already removed: %s", orch.socketPath)
            return nil
        }
        return fmt.Errorf("failed to remove socket file: %w", err)
    }

    log.Printf("Socket file removed: %s", orch.socketPath)
    return nil
}
```

---

## V. Phased Implementation Strategy

To reduce risk and ensure stability, we recommend a phased implementation strategy where each stage can be independently verified and rolled back.

### Stage 0: Preparation (1-2 days)

**Goal**: Establish testing environment and infrastructure

**Tasks**:
1. **Code Branch Management**
   ```bash
   git checkout -b feature/daemon-detach-support
   git checkout -b feature/daemon-detach-support-backup  # Backup branch
   ```

2. **Testing Environment Setup**
   - Create test config file: `test-tmux.yaml`
   - Prepare multi-user test environment (if needed)
   - Setup CI/CD pipeline (optional)

3. **Baseline Testing**
   - Record current system performance metrics
   - Record current behavior (as regression test baseline)
   ```bash
   # Create test script
   cat > tests/baseline_test.sh <<'EOF'
   #!/bin/bash
   # Baseline test: record current behavior
   set -e

   echo "Testing current behavior..."

   # Start session
   ./opencode-tmux baseline-test

   # Check processes
   ps aux | grep opencode-tmux

   # Check tmux session
   tmux ls

   # Ctrl+C simulation
   # ...

   echo "Baseline recorded"
   EOF
   chmod +x tests/baseline_test.sh
   ```

4. **Documentation and TODOs**
   - Copy `detach-shutdown-design.md` to `docs/implementation-plan.md`
   - Create GitHub Issues/Milestones to track progress

**Deliverables**:
- ✅ Test branches created
- ✅ Baseline test scripts
- ✅ Implementation plan documentation

---

### Stage 1: Infrastructure (3-5 days)

**Goal**: Implement foundational components without affecting existing functionality

**Phase 1.1: Socket Status Checker (1 day)**
```bash
# Create new files
internal/socket/status.go
internal/socket/status_test.go
```

Implementation:
- `SocketStatus` enumeration
- `CheckSocketStatus()` function
- `CleanupStaleSocket()` function
- Unit tests

**Verification**:
```bash
go test ./internal/socket/... -v
```

**Phase 1.2: Client Tracker (2 days)**
```bash
# Create new files
internal/client/tracker.go
internal/client/tracker_test.go
```

Implementation:
- `ClientTracker` structure
- `GetConnectedClients()` method
- `MonitorClients()` method
- Unit tests (mock tmux commands)

**Verification**:
```bash
go test ./internal/client/... -v
```

**Phase 1.3: Integration into Orchestrator (1-2 days)**

Modify files:
- `cmd/opencode-tmux/main.go`

Add fields:
```go
type TmuxOrchestrator struct {
    // ... existing fields ...

    clientTracker *ClientTracker  // New
    // Not used yet, just integration
}
```

Initialize in `Start()` (but don't start monitoring):
```go
orch.clientTracker = client.NewClientTracker(
    orch.sessionName,
    orch.tmuxCommand,
    5 * time.Second,
)
// Don't call MonitorClients yet
```

**Verification**:
```bash
# Ensure compilation passes
go build ./cmd/opencode-tmux

# Ensure existing functionality works
./opencode-tmux stage1-test
# ... test existing features ...
```

**Commit**:
```bash
git add .
git commit -m "feat: add socket status checker and client tracker (no-op integration)"
git push origin feature/daemon-detach-support
```

---

### Stage 2: Socket Cleanup Enhancement (2-3 days)

**Goal**: Improve socket lifecycle management while maintaining backward compatibility

**Phase 2.1: Socket Check on Startup (1 day)**

Modify `cmd/opencode-tmux/main.go`:
```go
func (orch *TmuxOrchestrator) Start() error {
    // 1. Create directories (existing)
    if err := orch.createDirectories(); err != nil {
        return err
    }

    // 2. New: check and cleanup socket
    if err := orch.ensureSocketClean(); err != nil {
        return err
    }

    // 3. Acquire lock (existing)
    // ...
}

func (orch *TmuxOrchestrator) ensureSocketClean() error {
    status, err := socket.CheckSocketStatus(orch.socketPath)

    switch status {
    case socket.SocketNonExistent:
        return nil  // Ideal case

    case socket.SocketStale:
        log.Printf("Found stale socket, cleaning up: %s", orch.socketPath)
        return socket.CleanupStaleSocket(orch.socketPath)

    case socket.SocketActive:
        // Backward compatible: if --force-new or similar flag, allow continue
        if orch.forceNewSession {
            log.Printf("WARNING: Forcing cleanup of active socket")
            return socket.CleanupStaleSocket(orch.socketPath)
        }
        return fmt.Errorf("socket is in use: %s", orch.socketPath)

    case socket.SocketPermissionDenied:
        return fmt.Errorf("permission denied: %s", orch.socketPath)
    }

    return fmt.Errorf("unknown socket status")
}
```

**Verification**:
```bash
# Test stale socket cleanup
./opencode-tmux test1 &
PID=$!
kill -9 $PID
# Socket should remain

./opencode-tmux test1
# Verify: auto-cleanup stale socket and start successfully
```

**Commit**:
```bash
git add .
git commit -m "feat: enhance socket lifecycle management with graceful cleanup"
git push origin feature/daemon-detach-support
```

---

### Stage 3: Signal Handling Refactoring (2-3 days)

**Goal**: Distinguish foreground and daemon modes, but maintain existing behavior by default

**Phase 3.1: RunMode Enumeration (1 day)**

Add to `main.go`:
```go
type RunMode int

const (
    ModeForeground RunMode = iota
    ModeDaemon
)

type TmuxOrchestrator struct {
    // ... existing fields ...
    runMode RunMode  // New, default ModeForeground (backward compatible)
}
```

Add flags:
```go
var (
    // ... existing flags ...
    daemonFlag     bool
    foregroundFlag bool
)

func init() {
    // ... existing flags ...
    flag.BoolVar(&daemonFlag, "daemon", false, "Run in daemon mode (Ctrl+C ignored)")
    flag.BoolVar(&foregroundFlag, "foreground", true, "Run in foreground mode (default)")
}
```

**Phase 3.2: Refactor waitForShutdown (1-2 days)**

Implement new `waitForShutdown()` logic (refer to design doc section 3.2.2)

**Note**: Default behavior remains unchanged (foreground mode), ensuring backward compatibility

**Verification**:
```bash
# Test default behavior (should be same as before)
./opencode-tmux test3
# Ctrl+C should trigger shutdown

# Test daemon mode
./opencode-tmux test4 --daemon --server-only
# Ctrl+C should be ignored
ps aux | grep opencode-tmux  # Verify still running
```

**Commit**:
```bash
git add .
git commit -m "feat: add daemon/foreground run modes (default to foreground for backward compat)"
```

---

### Stage 4: CLI Subcommand System (5-7 days)

**Goal**: Add `start/attach/detach/stop/status/list` subcommands

**Phase 4.1: Command Dispatcher (1 day)**

Refactor `main.go`:
```go
func main() {
    if len(os.Args) < 2 {
        // Backward compatible: use old logic when no subcommand
        runLegacyMode()
        return
    }

    subcommand := os.Args[1]

    // If first arg not a known subcommand, try as old-style arg
    knownCommands := []string{"start", "attach", "detach", "stop", "status", "list", "help", "version"}
    if !contains(knownCommands, subcommand) {
        runLegacyMode()
        return
    }

    switch subcommand {
    case "start":
        cmdStart(os.Args[2:])
    case "attach":
        cmdAttach(os.Args[2:])
    // ... other commands ...
    default:
        fmt.Fprintf(os.Stderr, "Unknown command: %s\n", subcommand)
        os.Exit(1)
    }
}

func runLegacyMode() {
    // Existing flag parsing and startup logic
    // Keep completely unchanged
}
```

**Phase 4.2: Implement Subcommands (3-4 days)**

Create directory structure:
```bash
mkdir -p cmd/opencode-tmux/commands
```

Implement 1-2 commands per day:
- Day 1: `start.go` and `stop.go`
- Day 2: `attach.go` and `detach.go`
- Day 3: `status.go` and `list.go`

**Note**:
- `start` command should call existing orchestrator initialization logic
- Reuse existing code as much as possible, minimize duplication

**Verification**:
```bash
# Test backward compatibility
./opencode-tmux old-style
# Should work like before

# Test new subcommands
./opencode-tmux start new-style --server-only
./opencode-tmux attach new-style
./opencode-tmux stop new-style
```

**Commit**:
```bash
git add .
git commit -m "feat: add CLI subcommand system with backward compatibility"
```

---

### Stage 5: IPC Extensions and Permission Control (3-4 days)

**Goal**: Extend IPC protocol, add permission checks

**Phase 5.1: IPC Interface Extension (2 days)**

Modify `internal/interfaces/orchestrator.go`:
```go
type OrchestratorControl interface {
    ReloadLayout() error
    Shutdown(cleanup bool) error

    // New
    GetStatus() (*SessionStatus, error)
    GetConnectedClients() ([]ClientInfo, error)
    Ping() error
}
```

Implement new methods (on orchestrator in `cmd/opencode-tmux/main.go`)

Update IPC server and client to support new message types

**Phase 5.2: Permission Control (1-2 days)**

Add `SessionOwner` and permission check logic (refer to design doc section 3.5)

**Verification**:
```bash
# Test permission checks
sudo -u user1 ./opencode-tmux start perm-test --server-only
sudo -u user2 ./opencode-tmux stop perm-test
# Should be denied
```

**Commit**:
```bash
git add .
git commit -m "feat: extend IPC protocol and add permission control"
```

---

### Stage 6: Process Supervision and Final Optimizations (3-5 days)

**Goal**: Enhance process supervision, optimize user experience

**Phase 6.1: Process Supervision Enhancement (2 days)**

Implement logic from design doc section 4.1:
- `PaneHealth` enumeration
- `checkAllPanesHealth()`
- `needsEnvUpdate()`
- Smart restart strategy

**Phase 6.2: User Experience Optimization (1-2 days)**

- Friendly error messages
- Tmux status bar integration
- `--check-clients` and `--force` options

**Phase 6.3: Configuration (1 day)**

Add `supervision` and `ipc` configuration sections to `tmux.yaml`

**Verification**:
```bash
# Run full integration test suite
./tests/full_integration_test.sh
```

**Commit**:
```bash
git add .
git commit -m "feat: enhance process supervision and UX optimizations"
```

---

### Stage 7: Documentation and Release (2-3 days)

**Phase 7.1: Documentation Updates (1 day)**

Update the following docs:
- `README.md` - Add new feature descriptions
- `docs/CLI.md` - Detailed CLI reference
- `docs/COLLABORATION.md` - Multi-user collaboration guide
- `CHANGELOG.md` - Record all changes

**Phase 7.2: Migration Guide (1 day)**

Create `docs/MIGRATION.md`:
```markdown
# Migration Guide: v1.x to v2.0

## Breaking Changes
None. The new version is fully backward compatible.

## New Features
1. CLI subcommands (start/attach/stop/etc.)
2. Daemon mode
3. Multi-user support
...

## Recommended Changes
While the old usage still works, we recommend migrating to the new CLI:

Old:
```bash
./opencode-tmux my-session
```

New:
```bash
./opencode-tmux start my-session
```
...
```

**Phase 7.3: Release Preparation (1 day)**

1. **Version Tagging**
   ```bash
   git tag -a v2.0.0 -m "Release v2.0.0: Daemon mode and multi-user support"
   git push origin v2.0.0
   ```

2. **Build Binaries**
   ```bash
   make build-all  # Build for various platforms
   ```

3. **Release Notes**
   Create GitHub Release including:
   - Feature highlights
   - Complete changelog
   - Migration guide link
   - Known issues (if any)

---

## VI. Key Design Decisions

### 6.1 Default Behavior Choice

**Decision**: Daemon mode as default

**Rationale**:
- Better aligns with "detach doesn't affect other users" requirement
- Avoids accidental session deletion by users
- More suitable for multi-user collaboration scenarios

**Backward Compatibility**:
- Keep `--foreground` flag for debugging and scripts
- Old no-subcommand invocation style still works

---

### 6.2 Auto Shutdown Strategy

**Decision**: **No** auto shutdown by default, even when all clients disconnect

**Rationale**:
- Avoid accidental stops (e.g., network fluctuations causing all clients to disconnect)
- Users may just be temporarily away, don't want daemon to stop
- Give users complete control

**Optional Configuration**:
- Provide `--auto-shutdown-when-empty` flag
- Support `auto_shutdown_timeout: 5m` in config file (auto shutdown 5 minutes after all clients disconnect)

---

### 6.3 Permission Model Choice

**Decision**: **Session Owner** based permission control

**Rationale**:
- Simple and clear: whoever starts the session has full control
- Avoid complex RBAC implementation
- Sufficient for small team collaboration

**Extensibility**:
- Reserve configuration interface, future can support `group` or `any` permission policies
- Can bypass restrictions via sudo/su (admin privileges)

---

### 6.4 Orphaned Session Handling

**Decision**: Allow orphaned sessions to exist, provide reuse mechanism

**Rationale**:
- Daemon crash shouldn't delete tmux session (protect user data)
- Allow manual recovery (`tmuxcoder start --reuse`)
- Users can choose to directly attach to orphaned session (no management features)

**Cleanup Strategy**:
- Don't auto-cleanup orphaned sessions
- Provide `tmuxcoder cleanup` command to cleanup all orphaned sessions (future feature)

---

## VII. Summary

### 7.1 Behavior Comparison

| Operation | Current Behavior | Improved Behavior |
|-----------|-----------------|-------------------|
| `Ctrl+b d` | Tmux detach, user usually closes terminal causing daemon to be triggered by SIGTERM/SIGINT shutdown | Tmux detach, daemon continues running (ignores SIGHUP) |
| `Ctrl+C` (terminal) | Triggers `SIGINT` → `waitForShutdown()` → `Stop()` → cleanup shutdown | **Daemon mode**: Ignore or log<br>**Foreground mode**: cleanup shutdown |
| Close terminal window | Triggers `SIGHUP` → shell exits → `SIGTERM` → shutdown | Already ignores `SIGHUP` ([main.go:2038-2042](cmd/opencode-tmux/main.go#L2038-L2042)) |
| No explicit command | - | **New**: `tmuxcoder detach` (graceful detach) |
| No explicit command | - | **New**: `tmuxcoder stop` (stop daemon, preserve session)<br>`tmuxcoder stop --cleanup` (full cleanup) |

### 7.2 Core Problems Solved

✅ **Problem 1**: User detach causes daemon shutdown
**Solution**: Refactor signal handling, daemon mode ignores `SIGINT`/`SIGTERM`

✅ **Problem 2**: Cannot distinguish "last user" from "one user"
**Solution**: Implement `ClientTracker` to track client connections

✅ **Problem 3**: No explicit detach command
**Solution**: Add `tmuxcoder detach` subcommand

✅ **Problem 4**: No permission control
**Solution**: Implement session owner based permission system

✅ **Problem 5**: Socket file management issues
**Solution**: Complete socket lifecycle management with stale detection

---

**Total Implementation Time**: Approximately 21-32 days (4-6 weeks)

**Recommended Team Size**: 1-2 developers

**Risk Level**: Low (phased approach with backward compatibility)
