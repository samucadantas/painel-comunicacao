#!/bin/bash
cd "$(dirname "$0")"
echo "Atualizando o painel…"
node sync.mjs && node build.mjs
echo ""
echo "Pronto. Abrindo…"
open "Painel.html"
