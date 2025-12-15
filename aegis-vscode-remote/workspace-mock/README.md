# Workspace Mock Image

This directory contains the Debian-based mock workspace image used for local VS Code remote testing. The container still relies on the upstream Debian base so we do not disrupt existing development workflows.

At runtime the `start-reh.sh` entrypoint mirrors the production bootstrap flow by sourcing any scripts present in `/workspace-bootstrap.d/*.sh` before launching the Remote Extension Host. The sample `bootstrap/99-echo.sh` script demonstrates the hook mechanism by logging a marker; tests can assert that hooks ran without requiring the UBI/Iron Bank production image locally.
