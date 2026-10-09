#!/bin/sh
# Writes the runtime configuration read by the Angular app before it starts.
cat > /usr/share/nginx/html/config.js <<CFG
window.__SCL__ = { backend: '${SCL_BACKEND:-real}', apiBase: '${SCL_API_BASE:-/api}', wsUrl: '${SCL_WS_URL:-}' };
CFG
echo "config.js written: backend=${SCL_BACKEND:-real}"
