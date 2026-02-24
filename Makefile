# Aegis Sovran - Development Makefile
#
# Proto sync: keeps aegis-vscode-remote extension proto in sync with
# the canonical proto definition in aegis-platform.

PLATFORM_PROTO := ../aegis-platform/proto/aegis/v1/platform.proto
EXTENSION_PROTO := aegis-vscode-remote/extension/proto/aegis_platform.proto

.PHONY: sync-proto check-proto

sync-proto:
	@echo "Syncing proto from aegis-platform..."
	cp $(PLATFORM_PROTO) $(EXTENSION_PROTO)
	@echo "Proto synced successfully"

check-proto:
	@echo "Checking proto sync status..."
	@diff -u $(PLATFORM_PROTO) $(EXTENSION_PROTO) \
		&& echo "Proto files are in sync" \
		|| (echo "ERROR: Proto files are out of sync. Run 'make sync-proto' to update." && exit 1)
