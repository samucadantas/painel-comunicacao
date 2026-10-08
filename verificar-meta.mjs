/**
 * verificar-meta.mjs — confere o que a chave da Meta alcança, antes de rodar o painel.
 *
 *   node verificar-meta.mjs
 *
 * Lista cada Página que o token enxerga e diz se ela tem Instagram conectado. Serve
 * para descobrir qual dos 7 perfis ficou de fora — e por quê — sem precisar esperar
 * o painel inteiro gerar para então notar um buraco.
 */
import { readFile } from "node:fs/promises";

for (const linha of (await readFile(new URL(".env", import.meta.url), "utf8").catch(() => "")).split("\n")) {
  const m = linha.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const token = process.env.META_TOKEN;
if (!token) {
  console.error("✗ Falta META_TOKEN — no painel/.env (local) ou no Secret do repositório (Actions)");
  process.exit(1);
}

const API = `https://graph.facebook.com/${process.env.META_VERSAO || "v23.0"}`;
const r = await fetch(
  `${API}/me/accounts?fields=name,instagram_business_account{username,followers_count,media_count}` +
  `&limit=100&access_token=${encodeURIComponent(token)}`
);
const j = await r.json();

if (j.error) {
  // A Meta repete o token dentro da mensagem de erro; some com ele antes de imprimir.
  console.error(`✗ A Meta recusou: ${(j.error.message || "").replace(/\bEAA[A-Za-z0-9]{20,}/g, "[chave]")}`);
  console.error("  Costuma ser permissão faltando na chave ou Página não atribuída ao usuário de sistema.");
  process.exit(1);
}

const paginas = j.data || [];
console.log(`${paginas.length} Página(s) alcançada(s) pela chave:\n`);
let ok = 0;
for (const p of paginas) {
  const ig = p.instagram_business_account;
  if (ig) {
    ok++;
    console.log(`  ✓ ${p.name} → @${ig.username} · ${ig.followers_count ?? "?"} seguidores · ${ig.media_count ?? "?"} publicações`);
  } else {
    console.log(`  ✗ ${p.name} → sem Instagram conectado (ou a conta do IG não foi atribuída ao usuário de sistema)`);
  }
}
console.log(`\n${ok} perfil(is) de Instagram prontos para o painel.`);
