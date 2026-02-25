#!/usr/bin/env bash
# Run cowrite locally in dev mode
# Usage:
#   ./run.sh serve              — browse any project file
#   ./run.sh preview <file>     — preview a specific file
#   ./run.sh serve --port 4000  — custom port

cd "$(dirname "$0")"
exec npx tsx bin/cowrite.ts "${@:-serve}"
