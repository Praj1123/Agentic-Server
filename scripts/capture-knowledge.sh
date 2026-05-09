#!/bin/bash
# capture-knowledge.sh — Run after adding/updating docs to re-index knowledge base
# Usage: ./scripts/capture-knowledge.sh

set -e
WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
AGENT="migration"

echo "📚 Capturing knowledge into agent..."
echo "   Workspace: $WORKSPACE"
echo ""

# Index all infrastructure docs
kiro-cli chat --no-interactive --trust-all-tools --agent "$AGENT" \
  "Please index the following into your knowledge base:
   1. Add 'terraform' from infra/ directory
   2. Add 'runbooks' from runbooks/ directory  
   3. Add 'architecture' from architecture/ directory
   4. Add 'incidents' from incidents/ directory
   Then show me the knowledge base status." \
  2>/dev/null

echo ""
echo "✅ Knowledge capture complete."
echo "   The agent now has semantic search over all your infra docs."
