//go:build integration

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestPaneSupervisorRespawnsProcess(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping supervisor integration test in short mode")
	}
	if _, err := exec.LookPath("tmux"); err != nil {
		t.Skipf("tmux not available: %v", err)
	}

	socketDir := filepath.Join(os.TempDir(), fmt.Sprintf("tmux-test-%d", time.Now().UnixNano()))
	if err := os.MkdirAll(socketDir, 0700); err != nil {
		t.Fatalf("failed to create tmux socket dir: %v", err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(socketDir) })
	t.Setenv("TMUX_TMPDIR", socketDir)

	sessionName := fmt.Sprintf("codex-supervisor-%d", time.Now().UnixNano())
	sessionCreated := false
	startSession := exec.Command("tmux", "new-session", "-d", "-s", sessionName, "sleep 600")
	if output, err := startSession.CombinedOutput(); err != nil {
		t.Skipf("tmux new-session unavailable in environment: %v: %s", err, strings.TrimSpace(string(output)))
	}
	sessionCreated = true
	defer func() {
		if sessionCreated {
			exec.Command("tmux", "kill-session", "-t", sessionName).Run()
		}
	}()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	orch := &TmuxOrchestrator{
		sessionName:     sessionName,
		ctx:             ctx,
		cancel:          cancel,
		tmuxCommand:     "tmux",
		paneSupervisors: map[string]context.CancelFunc{},
	}
	defer func() {
		orch.paneSupervisorMu.Lock()
		for _, stop := range orch.paneSupervisors {
			stop()
		}
		orch.paneSupervisorMu.Unlock()
	}()

	tmpDir := t.TempDir()
	logPath := filepath.Join(tmpDir, "supervisor.log")
	flagPath := filepath.Join(tmpDir, "supervisor.flag")
	scriptPath := filepath.Join(tmpDir, "panel.sh")
	script := fmt.Sprintf(`#!/bin/sh
LOG=%q
FLAG=%q
if [ ! -f "$FLAG" ]; then
  echo "initial $$" >> "$LOG"
  touch "$FLAG"
  exit 0
fi
echo "restart $$" >> "$LOG"
sleep 5
`, logPath, flagPath)
	if err := os.WriteFile(scriptPath, []byte(script), 0755); err != nil {
		t.Fatalf("failed to write supervisor script: %v", err)
	}

	paneTarget := fmt.Sprintf("%s:0.0", sessionName)
	if err := orch.startPanelApp(paneTarget, scriptPath, map[string]string{}); err != nil {
		errText := err.Error()
		if strings.Contains(errText, "respawn pane") || strings.Contains(errText, "error connecting") {
			t.Skipf("tmux respawn unavailable in sandbox: %v", err)
		}
		t.Fatalf("startPanelApp failed: %v", err)
	}

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		data, err := os.ReadFile(logPath)
		if err == nil && strings.Contains(string(data), "restart") {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}

	data, _ := os.ReadFile(logPath)
	t.Fatalf("pane supervisor did not restart process; log contents: %s", strings.TrimSpace(string(data)))
}
