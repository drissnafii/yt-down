.PHONY: setup install start dev link clean check-bun check-yt-dlp check-ffmpeg check-deps build

# ─── Colors ───────────────────────────────────────────────────────────────────
RED    := \033[0;31m
GREEN  := \033[0;32m
YELLOW := \033[0;33m
CYAN   := \033[0;36m
BOLD   := \033[1m
RESET  := \033[0m

# ─── Setup (one command to rule them all) ─────────────────────────────────────
setup: check-bun check-yt-dlp check-ffmpeg install create-output-dir build install-bin
	@echo ""
	@echo "$(GREEN)$(BOLD)✅ yt-down is ready!$(RESET)"
	@echo "$(CYAN)   Run 'yt-down' from anywhere on your system$(RESET)"
	@echo ""

# ─── Check / Install: Bun ─────────────────────────────────────────────────────
check-bun:
	@echo "$(CYAN)▶ Checking bun...$(RESET)"
	@if command -v bun > /dev/null 2>&1; then \
		echo "$(GREEN)  ✓ bun $(shell bun --version) already installed$(RESET)"; \
	else \
		echo "$(YELLOW)  ⚠ bun not found — installing...$(RESET)"; \
		curl -fsSL https://bun.sh/install | bash; \
		echo "$(GREEN)  ✓ bun installed$(RESET)"; \
		echo "$(YELLOW)  ⚠ Restart your shell or run: source ~/.bashrc$(RESET)"; \
	fi

# ─── Check / Install: yt-dlp ──────────────────────────────────────────────────
check-yt-dlp:
	@echo "$(CYAN)▶ Checking yt-dlp...$(RESET)"
	@if command -v yt-dlp > /dev/null 2>&1; then \
		echo "$(GREEN)  ✓ yt-dlp $(shell yt-dlp --version) already installed$(RESET)"; \
	else \
		echo "$(YELLOW)  ⚠ yt-dlp not found — installing to /usr/local/bin/yt-dlp...$(RESET)"; \
		sudo curl -sSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp; \
		sudo chmod a+rx /usr/local/bin/yt-dlp; \
		echo "$(GREEN)  ✓ yt-dlp $(shell yt-dlp --version 2>/dev/null || echo 'installed') ready$(RESET)"; \
	fi

# ─── Check / Install: ffmpeg ──────────────────────────────────────────────────
check-ffmpeg:
	@echo "$(CYAN)▶ Checking ffmpeg...$(RESET)"
	@if command -v ffmpeg > /dev/null 2>&1; then \
		echo "$(GREEN)  ✓ ffmpeg already installed$(RESET)"; \
	else \
		echo "$(YELLOW)  ⚠ ffmpeg not found — installing via apt...$(RESET)"; \
		sudo apt-get install -y ffmpeg; \
		echo "$(GREEN)  ✓ ffmpeg installed$(RESET)"; \
	fi

# ─── Create output directory ──────────────────────────────────────────────────
create-output-dir:
	@echo "$(CYAN)▶ Checking output directory...$(RESET)"
	@if [ -d "/home/$$USER/Videos/yt-down" ]; then \
		echo "$(GREEN)  ✓ ~/Videos/yt-down already exists$(RESET)"; \
	else \
		mkdir -p "/home/$$USER/Videos/yt-down"; \
		echo "$(GREEN)  ✓ Created ~/Videos/yt-down$(RESET)"; \
	fi

# ─── Install npm/bun deps ─────────────────────────────────────────────────────
install:
	@echo "$(CYAN)▶ Installing node dependencies...$(RESET)"
	@bun install
	@echo "$(GREEN)  ✓ Dependencies installed$(RESET)"

# ─── Check all dependencies (no install, just report) ────────────────────────
check-deps:
	@echo ""
	@echo "$(BOLD)Dependency Status$(RESET)"
	@echo "─────────────────────────────────"
	@if command -v bun > /dev/null 2>&1; then \
		echo "$(GREEN)  ✓ bun        $(shell bun --version)$(RESET)"; \
	else \
		echo "$(RED)  ✗ bun        not found$(RESET)"; \
	fi
	@if command -v yt-dlp > /dev/null 2>&1; then \
		echo "$(GREEN)  ✓ yt-dlp     $(shell yt-dlp --version)$(RESET)"; \
	else \
		echo "$(RED)  ✗ yt-dlp     not found$(RESET)"; \
	fi
	@if command -v ffmpeg > /dev/null 2>&1; then \
		echo "$(GREEN)  ✓ ffmpeg     installed$(RESET)"; \
	else \
		echo "$(RED)  ✗ ffmpeg     not found$(RESET)"; \
	fi
	@if [ -f "node_modules/.package-lock.json" ] || [ -d "node_modules" ]; then \
		echo "$(GREEN)  ✓ node_modules installed$(RESET)"; \
	else \
		echo "$(RED)  ✗ node_modules missing — run: make install$(RESET)"; \
	fi
	@echo "─────────────────────────────────"
	@echo ""

# ─── Update yt-dlp to latest ──────────────────────────────────────────────────
update-yt-dlp:
	@echo "$(CYAN)▶ Updating yt-dlp to latest...$(RESET)"
	@sudo curl -sSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp
	@sudo chmod a+rx /usr/local/bin/yt-dlp
	@echo "$(GREEN)  ✓ yt-dlp updated to $$($$(command -v yt-dlp) --version) at $$(command -v yt-dlp)$(RESET)"

# ─── Build binary ─────────────────────────────────────────────────────────────
build:
	@echo "$(CYAN)▶ Compiling to binary...$(RESET)"
	@bun build ./bin/yt-down.ts --compile --outfile ./bin/yt-down-bin
	@echo "$(GREEN)  ✓ Binary built at ./bin/yt-down-bin$(RESET)"

# ─── Install binary to /usr/local/bin ─────────────────────────────────────────
install-bin: build
	@echo "$(CYAN)▶ Installing yt-down to /usr/local/bin...$(RESET)"
	@sudo cp ./bin/yt-down-bin /usr/local/bin/yt-down
	@sudo chmod +x /usr/local/bin/yt-down
	@echo "$(GREEN)  ✓ 'yt-down' is now available system-wide$(RESET)"

# ─── Uninstall binary from /usr/local/bin ────────────────────────────────────
uninstall:
	@echo "$(CYAN)▶ Removing yt-down from /usr/local/bin...$(RESET)"
	@sudo rm -f /usr/local/bin/yt-down
	@echo "$(GREEN)  ✓ Uninstalled$(RESET)"

# ─── Link globally (alternative via bun link) ─────────────────────────────────
link:
	@echo "$(CYAN)▶ Linking yt-down globally via bun...$(RESET)"
	@bun link
	@echo "$(GREEN)  ✓ Run 'yt-down' from anywhere$(RESET)"

# ─── Run ──────────────────────────────────────────────────────────────────────
start:
	@bun run bin/yt-down.ts

dev:
	@bun run --watch bin/yt-down.ts

# ─── Clean ────────────────────────────────────────────────────────────────────
clean:
	@echo "$(CYAN)▶ Cleaning...$(RESET)"
	@rm -rf node_modules bun.lock
	@echo "$(GREEN)  ✓ Cleaned$(RESET)"
