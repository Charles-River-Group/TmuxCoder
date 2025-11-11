package interfaces

// OrchestratorControl exposes control operations that can be invoked over IPC.
type OrchestratorControl interface {
	// ReloadLayout triggers the orchestrator to reload the tmux layout configuration
	// and apply it to the running session without restarting panel processes.
	ReloadLayout() error
}
