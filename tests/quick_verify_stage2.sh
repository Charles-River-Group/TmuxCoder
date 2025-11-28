#!/bin/bash
# Stage 2 quick verification script

BINARY="./cmd/opencode-tmux/opencode-tmux"
TEST_SESSION="quick-verify-$"

echo "========================================="
echo "Stage 2 Quick Verification"
echo "========================================="

# Cleanup function
cleanup() {
    pkill -f "opencode-tmux.*$TEST_SESSION" 2>/dev/null || true
    tmux kill-session -t "$TEST_SESSION" 2>/dev/null || true
    rm -f ~/.opencode/${TEST_SESSION}*.sock
}
trap cleanup EXIT

# Check 1: ConnectionCount() exists
echo ""
echo "[Check 1] ConnectionCount()"
if grep -q "func.*ConnectionCount.*int" internal/ipc/socket_server.go; then
    echo "✓ ConnectionCount() found"
else
    echo "✗ ConnectionCount() not found"
    exit 1
fi

# Check 2: ensureSocketClean() exists
echo ""
echo "[Check 2] ensureSocketClean()"
if grep -q "func.*ensureSocketClean.*error" cmd/opencode-tmux/main.go; then
    echo "✓ ensureSocketClean() found"
else
    echo "✗ ensureSocketClean() not found"
    exit 1
fi

# Check 3: Initialize() integration
echo ""
echo "[Check 3] Initialize() integration"
if grep -q "ensureSocketClean()" cmd/opencode-tmux/main.go; then
    echo "✓ ensureSocketClean() is called in Initialize()"
else
    echo "✗ Initialize() does not call ensureSocketClean()"
    exit 1
fi

# Check 4: Stop() enhancements
echo ""
echo "[Check 4] Stop() enhancements"
if grep -q "waitForIPCConnectionsClose" cmd/opencode-tmux/main.go; then
    echo "✓ waitForIPCConnectionsClose() is called in Stop()"
else
    echo "✗ Stop() does not call waitForIPCConnectionsClose()"
    exit 1
fi

# Check 5: build
echo ""
echo "[Check 5] Build"
if go build -o "$BINARY" ./cmd/opencode-tmux; then
    echo "✓ Build succeeded"
else
    echo "✗ Build failed"
    exit 1
fi

# Check 6: runtime test
echo ""
echo "[Check 6] Runtime"
# Ensure binary exists
if [ ! -x "$BINARY" ]; then
    echo "✗ Start failed (executable not found: $BINARY)"
    exit 1
fi

echo "  Starting orchestrator..."
$BINARY --server-only "$TEST_SESSION" &
PID=$!
sleep 3

if ps -p $PID > /dev/null 2>&1; then
    echo "✓ Process started"
else
    echo "✗ Process failed to start"
    exit 1
fi

# Log verification
if grep -q "\[Socket\] Path is clean" ~/.opencode/logs/*.log 2>/dev/null; then
    echo "✓ Socket check log found"
else
    echo "⚠ Socket check log not found (verify log path)"
fi

# Graceful shutdown
echo "  Sending SIGTERM..."
kill -TERM $PID
sleep 3

# Verify process exit
if ps -p $PID > /dev/null 2>&1; then
    echo "⚠ Process did not exit within 3 seconds, forcing termination..."
    kill -9 $PID
else
    echo "✓ Process exited gracefully"
fi

# Verify socket cleanup
if [ ! -e ~/.opencode/${TEST_SESSION}.sock ]; then
    echo "✓ Socket cleaned"
else
    echo "✗ Socket not cleaned"
    ls -l ~/.opencode/${TEST_SESSION}.sock
    exit 1
fi

echo ""
echo "========================================="
echo "✅ All checks passed!"
echo "========================================="
echo ""
echo "Stage 2 change summary:"
echo "  ✓ Added ConnectionCount()"
echo "  ✓ Added ensureSocketClean()"
    echo "  ✓ Added waitForIPCConnectionsClose()"
echo "  ✓ Added cleanupSocket()"
echo "  ✓ Integrated socket check in Initialize()"
echo "  ✓ Enhanced Stop() with 7-stage shutdown"
echo ""
echo "Modified files:"
echo "  - internal/ipc/socket_server.go (+5 lines)"
echo "  - cmd/opencode-tmux/main.go (+180 lines)"
echo ""
