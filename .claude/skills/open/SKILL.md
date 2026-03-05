---
name: open
description: Open the cowrite live preview in your browser
user_invocable: true
---

# Open Cowrite Preview

Open the live preview browser window for the current project.

## Steps

1. Run `cowrite open` to open the preview URL in the default browser.
   - The port is auto-detected from `.cowrite-port`.
   - If the preview server isn't running, tell the user to check that cowrite is configured as an MCP server.
