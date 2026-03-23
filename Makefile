# Aegis Sovran - Development Makefile
#
# Proto sync: keeps aegis-vscode-remote extension proto in sync with
# the canonical proto definition in aegis-platform.
#
# Chart sync: keeps Helm chart templates that must stay identical
# (RBAC, deployment) in sync with aegis-platform's canonical chart.

PLATFORM_PROTO := ../aegis-platform/proto/aegis/v1/platform.proto
EXTENSION_PROTO := aegis-vscode-remote/extension/proto/aegis_platform.proto

PLATFORM_CHART := ../aegis-platform/charts/aegis-services/templates
SOVRAN_CHART   := cloud-terraform/charts/aegis-services/templates

# Chart templates that MUST stay in sync with aegis-platform.
# Add new entries here when aegis-platform introduces templates that
# sovran also deploys. Only list files that exist in both charts.
SYNCED_CHART_TEMPLATES := \
	platform-api-rbac.yaml

.PHONY: sync-proto check-proto sync-charts check-charts sync-all check-all

# ── Proto sync ──────────────────────────────────────────────────────

sync-proto:
	@echo "Syncing proto from aegis-platform..."
	cp $(PLATFORM_PROTO) $(EXTENSION_PROTO)
	@echo "Proto synced successfully"

check-proto:
	@echo "Checking proto sync status..."
	@diff -u $(PLATFORM_PROTO) $(EXTENSION_PROTO) \
		&& echo "Proto files are in sync" \
		|| (echo "ERROR: Proto files are out of sync. Run 'make sync-proto' to update." && exit 1)

# ── Chart sync ──────────────────────────────────────────────────────

sync-charts:
	@echo "Syncing chart templates from aegis-platform..."
	@for f in $(SYNCED_CHART_TEMPLATES); do \
		cp "$(PLATFORM_CHART)/$$f" "$(SOVRAN_CHART)/$$f" && \
		echo "  synced $$f"; \
	done
	@echo "Chart templates synced successfully"

check-charts:
	@echo "Checking chart template sync status..."
	@fail=0; \
	for f in $(SYNCED_CHART_TEMPLATES); do \
		if ! diff -u "$(PLATFORM_CHART)/$$f" "$(SOVRAN_CHART)/$$f" > /dev/null 2>&1; then \
			echo "DRIFT: $$f"; \
			diff -u "$(PLATFORM_CHART)/$$f" "$(SOVRAN_CHART)/$$f" || true; \
			fail=1; \
		fi; \
	done; \
	if [ "$$fail" = "1" ]; then \
		echo "ERROR: Chart templates have drifted. Run 'make sync-charts' to update."; \
		exit 1; \
	fi; \
	echo "Chart templates are in sync"

# ── Convenience targets ─────────────────────────────────────────────

sync-all: sync-proto sync-charts
	@echo "All syncs complete"

check-all: check-proto check-charts
	@echo "All checks passed"
