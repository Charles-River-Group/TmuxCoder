#!/bin/bash
# Stage 5 Integration Test Script
# Tests IPC extensions and permission control

set -e

echo "=================================================="
echo "Stage 5 Integration Test - IPC Extensions and Permission Control"
echo "=================================================="
echo ""

# Color definitions
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test counters
TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Helper functions
pass() {
    echo -e "${GREEN}✓ PASS${NC}: $1"
    ((TESTS_PASSED++))
}

fail() {
    echo -e "${RED}✗ FAIL${NC}: $1"
    ((TESTS_FAILED++))
}

info() {
    echo -e "${YELLOW}ℹ INFO${NC}: $1"
}

test_start() {
    ((TESTS_RUN++))
    echo ""
    echo "Test $TESTS_RUN: $1"
    echo "----------------------------------------"
}

# 1. Unit tests
test_start "Run permission system unit tests"
if go test -v ./internal/permission/... > /tmp/permission_test.log 2>&1; then
    pass "Permission system unit tests passed"
    grep "PASS" /tmp/permission_test.log | tail -5
else
    fail "Permission system unit tests failed"
    cat /tmp/permission_test.log
fi

test_start "Run credential system unit tests"
if go test -v ./internal/ipc/... -run "TestGetCurrentUser|TestToSessionOwner" > /tmp/credentials_test.log 2>&1; then
    pass "Credential system unit tests passed"
    grep "Current user:" /tmp/credentials_test.log || true
else
    fail "Credential system unit tests failed"
    cat /tmp/credentials_test.log
fi

# 2. Build test
test_start "Build project"
if go build -o /tmp/tmuxcoder-test ./cmd/opencode-tmux/... > /tmp/build.log 2>&1; then
    pass "Project build succeeded"
else
    fail "Project build failed"
    cat /tmp/build.log
fi

# 3. Static analysis
test_start "Static analysis"
if go vet ./internal/ipc/... ./internal/permission/... > /tmp/vet.log 2>&1; then
    pass "Static analysis passed"
else
    fail "Static analysis found issues"
    cat /tmp/vet.log
fi

# 4. Test coverage
test_start "Generate test coverage report"
if go test -coverprofile=/tmp/coverage.out ./internal/permission/... ./internal/ipc/... > /tmp/coverage.log 2>&1; then
    pass "Test coverage report generated"
    go tool cover -func=/tmp/coverage.out | tail -10
else
    fail "Failed to generate test coverage report"
    cat /tmp/coverage.log
fi

# 5. Check exported symbols
test_start "Check exported APIs"
info "Check exported types and functions from permission package..."
go doc github.com/opencode/tmux_coder/internal/permission | head -20

info "Check exported types from interfaces package..."
go doc github.com/opencode/tmux_coder/internal/interfaces | grep -E "(IpcRequester|SessionOwner|SessionStatus)" || true

# 总结
echo ""
echo "=================================================="
echo "Test Summary"
echo "=================================================="
echo "Tests run: $TESTS_RUN"
echo -e "Passed: ${GREEN}$TESTS_PASSED${NC}"
echo -e "Failed: ${RED}$TESTS_FAILED${NC}"
echo ""

if [ $TESTS_FAILED -eq 0 ]; then
    echo -e "${GREEN}All tests passed! ✓${NC}"
    exit 0
else
    echo -e "${RED}$TESTS_FAILED test(s) failed ✗${NC}"
    exit 1
fi
