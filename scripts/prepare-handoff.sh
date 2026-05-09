#!/bin/bash
# prepare-handoff.sh — Prepares the agent for client delivery
# Removes migration-only files, validates client agent, packages for delivery
# Usage: ./scripts/prepare-handoff.sh <client-name>

set -e

CLIENT_NAME="${1:-client}"
WORKSPACE="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT_DIR="$WORKSPACE/delivery-${CLIENT_NAME}"

echo "📦 Preparing agent handoff for: $CLIENT_NAME"
echo ""

# Validate client-delivery agent config
echo "1. Validating agent configuration..."
if command -v kiro-cli &> /dev/null; then
    kiro-cli agent validate --path "$WORKSPACE/.kiro/agents/client-delivery.json" 2>/dev/null && echo "   ✅ Agent config valid" || echo "   ⚠️  Validate manually"
else
    echo "   ⚠️  kiro-cli not found, skipping validation"
fi

# Check that system prompt has been filled
echo "2. Checking system prompt..."
if grep -q "\[CLIENT_NAME\]" "$WORKSPACE/prompts/system-prompt.md"; then
    echo "   ⚠️  WARNING: System prompt still has placeholders! Fill them before delivery."
else
    echo "   ✅ System prompt customized"
fi

# Check skills are filled
echo "3. Checking skills..."
EMPTY_SKILLS=0
for skill in "$WORKSPACE"/.kiro/skills/*/SKILL.md; do
    if grep -q "<!-- FILL DURING MIGRATION -->" "$skill"; then
        echo "   ⚠️  Unfilled: $skill"
        EMPTY_SKILLS=$((EMPTY_SKILLS + 1))
    fi
done
[ $EMPTY_SKILLS -eq 0 ] && echo "   ✅ All skills filled"

# Create delivery package
echo "4. Creating delivery package..."
mkdir -p "$OUTPUT_DIR"

# Copy only what client needs
cp -r "$WORKSPACE/.kiro" "$OUTPUT_DIR/"
cp -r "$WORKSPACE/runbooks" "$OUTPUT_DIR/"
cp -r "$WORKSPACE/architecture" "$OUTPUT_DIR/"
cp -r "$WORKSPACE/incidents" "$OUTPUT_DIR/"
cp -r "$WORKSPACE/prompts" "$OUTPUT_DIR/"
cp -r "$WORKSPACE/web" "$OUTPUT_DIR/"

# Remove migration agent from delivery
rm -f "$OUTPUT_DIR/.kiro/agents/migration.json"

# Remove scripts (client doesn't need these)
rm -rf "$OUTPUT_DIR/scripts" 2>/dev/null

echo ""
echo "✅ Delivery package ready at: $OUTPUT_DIR"
echo ""
echo "Client setup instructions:"
echo "  1. Install kiro-cli"
echo "  2. cd $OUTPUT_DIR"
echo "  3. cd web/backend && npm install && npm start"
echo "  4. Open http://localhost:3001"
echo "  OR"
echo "  5. kiro-cli chat --agent client-delivery"
