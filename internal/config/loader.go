package config

import (
	"errors"
	"fmt"
	"io/fs"
	"os"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

// SessionConfig captures the tmux session configuration.
type SessionConfig struct {
	Version string  `yaml:"version"`
	Session Session `yaml:"session"`
}

// Layout describes the tmux panel layout.
type Layout struct {
	Version string  `yaml:"version"`
	Mode    string  `yaml:"mode"`
	Panels  []Panel `yaml:"panels"`
	Splits  []Split `yaml:"splits"`
}

type Session struct {
	Name string `yaml:"name"`
}

type Panel struct {
	ID      string `yaml:"id"`
	Module  string `yaml:"module"`
	Type    string `yaml:"type"`
	Width   string `yaml:"width"`
	Height  string `yaml:"height"`
	Command string `yaml:"command"`
}

type Split struct {
	Type   string   `yaml:"type"`
	Target string   `yaml:"target"`
	Panels []string `yaml:"panels"`
	Ratio  string   `yaml:"ratio"`
}

// DefaultSession returns the built-in session configuration.
func DefaultSession() *SessionConfig {
	return &SessionConfig{
		Version: "1.0",
		Session: Session{Name: "opencode"},
	}
}

// DefaultLayout returns the built-in layout configuration.
func DefaultLayout() *Layout {
	return &Layout{
		Version: "1.0",
		Mode:    "raw",
		Panels: []Panel{
			{ID: "sessions", Type: "sessions", Width: "20%"},
			{ID: "messages", Type: "messages"},
			{ID: "input", Type: "input", Height: "20%"},
		},
		Splits: []Split{
			{Type: "horizontal", Target: "root", Panels: []string{"sessions", "messages"}},
			{Type: "vertical", Target: "messages", Panels: []string{"messages", "input"}},
		},
	}
}

// LoadSession loads the session configuration from the provided path.
func LoadSession(path string) (*SessionConfig, error) {
	cfg := DefaultSession()

	data, err := readConfigFile(path)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return cfg, nil
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse tmux session config: %w", err)
	}

	cfg.ensureDefaults()
	return cfg, nil
}

// LoadLayout loads the layout configuration from the provided path.
func LoadLayout(path string) (*Layout, error) {
	cfg := DefaultLayout()

	data, err := readConfigFile(path)
	if err != nil {
		return nil, err
	}
	if data == nil {
		return cfg, nil
	}

	if err := yaml.Unmarshal(data, cfg); err != nil {
		return nil, fmt.Errorf("parse tmux layout config: %w", err)
	}

	cfg.ensureDefaults()
	return cfg, nil
}

func (c *SessionConfig) ensureDefaults() {
	if c.Version == "" {
		c.Version = "1.0"
	}
	if c.Session.Name == "" {
		c.Session.Name = "opencode"
	}
}

func (l *Layout) ensureDefaults() {
	if l.Version == "" {
		l.Version = "1.0"
	}
	if l.Mode == "" {
		l.Mode = "raw"
	}
	if len(l.Panels) == 0 {
		l.Panels = DefaultLayout().Panels
	}
	if len(l.Splits) == 0 {
		l.Splits = DefaultLayout().Splits
	}
}

// RatioPercents converts ratio strings into percentage values.
func (l *Layout) RatioPercents(value string) (int, int, bool) {
	parts := strings.Split(value, ":")
	if len(parts) != 2 {
		return 0, 0, false
	}

	a, errA := strconv.Atoi(strings.TrimSpace(parts[0]))
	if errA != nil {
		return 0, 0, false
	}

	b, errB := strconv.Atoi(strings.TrimSpace(parts[1]))
	if errB != nil {
		return 0, 0, false
	}

	total := a + b
	if total == 0 {
		return 0, 0, false
	}

	first := a * 100 / total
	second := 100 - first
	return first, second, true
}

func readConfigFile(path string) ([]byte, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, nil
		}
		return nil, fmt.Errorf("read tmux config: %w", err)
	}

	if strings.TrimSpace(string(data)) == "" {
		return nil, nil
	}

	return data, nil
}
