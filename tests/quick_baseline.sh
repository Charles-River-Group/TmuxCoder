#!/bin/bash
# Quick baseline test - simplified version for rapid checks

set -e

TEST_SESSION="quick-baseline-$$"
echo "Quick Baseline Test - Session: $TEST_SESSION"
echo ""

# Check prerequisites
command -v tmux >/dev/null 2>&1 || { echo "tmux not found"; exit 1; }
command -v go >/dev/null 2>&1 || { echo "go not found"; exit 1; }

# Build if needed
if [ ! -f "./cmd/opencode-tmux/opencode-tmux" ]; then
    echo "Building opencode-tmux..."
    cd cmd/opencode-tmux && go build && cd ../..
fi

echo "✓ Prerequisites checked"
echo "✓ Binary exists"
echo ""
echo "Current git branch: $(git branch --show-current)"
echo "Latest commit: $(git log --oneline -1)"
echo ""
echo "Ready for development!"
