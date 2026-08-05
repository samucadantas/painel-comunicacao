#!/usr/bin/env node
/**
 * build.mjs — injeta data/painel.json dentro de template.html e gera o arquivo final.
 *
 * Saídas:
 *   Painel.html            → abre com dois cliques, funciona offline, dá pra mandar no WhatsApp
 *   publicar/index.html    → mesma coisa, pronta pra arrastar no Netlify (link fixo)
 *
 * Nenhuma das duas contém token: só os números já calculados.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

const dados = await readFile(join(__dir, "data", "painel.json"), "utf8");
const template = await readFile(join(__dir, "template.html"), "utf8");

const MARCA = /\/\*__DADOS__\*\/[\s\S]*?\/\*__FIM__\*\//;
if (!MARCA.test(template)) {
  console.error("✗ template.html não tem o marcador /*__DADOS__*/ … /*__FIM__*/");
  process.exit(1);
}

// </script> dentro do JSON quebraria o HTML — escapa por segurança
const seguro = dados.replace(/<\/script/gi, "<\\/script");
const html = template.replace(MARCA, `/*__DADOS__*/${seguro}/*__FIM__*/`);

await writeFile(join(__dir, "Painel.html"), html);
await mkdir(join(__dir, "publicar"), { recursive: true });
await writeFile(join(__dir, "publicar", "index.html"), html);

const kb = (html.length / 1024).toFixed(0);
const d = JSON.parse(dados);
console.log(`✓ Painel.html e publicar/index.html gerados (${kb} KB)`);
console.log(`  ${d.meses[0].label}: ${d.meses[0].finalizadas} entregas · ${d.agora.em_aberto} na fila · ${d.agora.atrasadas_total} atrasadas`);
