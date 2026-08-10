/**
 * genna.mjs — cliente MCP mínimo (JSON-RPC sobre HTTP) para o Genna.
 *
 * O Genna é a fonte das métricas de Instagram que o Instagram web não entrega:
 * salvamentos, compartilhamentos e desempenho por publicação, com recorte de data exato.
 *
 * Precisa de GENNA_API_KEY no .env. Sem ela, o sync segue sem a parte do Genna.
 */

const URL = process.env.GENNA_URL || "https://mcp.genna.co";

let sessionId = null;
let id = 0;

function headers(key) {
  const h = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    Authorization: `Bearer ${key}`,
  };
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

async function rpc(key, method, params) {
  const r = await fetch(URL, {
    method: "POST",
    headers: headers(key),
    body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params: params ?? {} }),
  });
  const sid = r.headers.get("mcp-session-id");
  if (sid) sessionId = sid;

  const texto = await r.text();
  if (!r.ok) throw new Error(`Genna ${method} -> ${r.status} ${texto.slice(0, 200)}`);

  // a resposta pode vir como SSE (linhas "data: {...}")
  const linhas = texto.split("\n").filter((l) => l.startsWith("data:"));
  const corpo = linhas.length ? linhas.map((l) => l.slice(5).trim()).join("") : texto;
  if (!corpo.trim()) return null;
  const j = JSON.parse(corpo);
  if (j.error) throw new Error(`Genna ${method} -> ${JSON.stringify(j.error).slice(0, 200)}`);
  return j.result;
}

async function chamar(key, nome, args) {
  const r = await rpc(key, "tools/call", { name: nome, arguments: args ?? {} });
  const txt = (r?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  try { return JSON.parse(txt); } catch { return txt; }
}

const listaDe = (x) => (Array.isArray(x) ? x : x?.posts || x?.items || x?.data || []);

function resume(posts) {
  const s = (k) => posts.reduce((t, p) => t + (p[k] || 0), 0);
  const alcance = s("reach");
  const interacoes = s("totalInteractions");
  return {
    publicacoes: posts.length,
    alcance,
    views: s("views"),
    likes: s("likes"),
    comentarios: s("comments"),
    compartilhamentos: s("shares"),
    salvamentos: s("saved"),
    interacoes,
    // engajamento = interações ÷ alcance, que é como o próprio Genna calcula por post
    taxa_engajamento: alcance ? Math.round((interacoes / alcance) * 1000) / 10 : null,
    por_formato: posts.reduce((acc, p) => {
      const t = { FEED_CAROUSEL: "Carrossel", REEL: "Reels", FEED_SINGLE_IMAGE: "Imagem", STORY: "Story" }[p.type] || p.type;
      acc[t] = (acc[t] || 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Um título para a publicação, no lugar da legenda cortada no meio.
 *
 * O Instagram não tem campo de título, então o mais próximo é a primeira frase da
 * legenda — que quase sempre é a chamada do post. Corta na primeira pontuação forte
 * ou na quebra de linha, tira hashtags e devolve algo que se lê como manchete.
 */
function resumoLegenda(caption) {
  const limpo = (caption || "")
    .replace(/#[\wÀ-ÿ]+/g, "")          // hashtags não são título
    .replace(/\s+/g, " ")
    .trim();
  if (!limpo) return "";
  // primeira frase: para no . ! ? ou : seguido de espaço/fim
  const frase = (limpo.match(/^(.{15,110}?)(?:[.!?:]|$)/) || [null, limpo])[1].trim();
  const t = frase.length >= 15 ? frase : limpo;
  return t.length > 110 ? t.slice(0, 108).trimEnd() + "…" : t;
}

const topPosts = (posts, n, chave = "reach") =>
  [...posts].sort((a, b) => (b[chave] || 0) - (a[chave] || 0)).slice(0, n).map((p) => ({
    data: p.timestamp.slice(0, 10),
    tipo: { FEED_CAROUSEL: "Carrossel", REEL: "Reels", FEED_SINGLE_IMAGE: "Imagem" }[p.type] || p.type,
    titulo: resumoLegenda(p.caption),
    link: p.permalink,
    alcance: p.reach,
    interacoes: p.totalInteractions,
    taxa: p.interactionsRatePct != null ? Math.round(p.interactionsRatePct * 10) / 10 : null,
    salvamentos: p.saved,
    compartilhamentos: p.shares,
    // URL assinada e temporária: o sync baixa e embute a imagem antes que ela expire.
    thumb_url: p.thumbnailUrl || null,
  }));

// Quando a conta está vinculada mas a página do Instagram não foi atribuída,
// o Genna responde com esta frase em vez de um objeto.
const SEM_PAGINA = /No connected Instagram page/i;

async function coletarMarca(key, brand, { mes, triDe, triAte }) {
  const perfil = await chamar(key, "get_analytics_profile", { brandId: brand.id });
  if (typeof perfil === "string") {
    return { brand: brand.id, marca: brand.name, erro: SEM_PAGINA.test(perfil)
      ? "conta vinculada, mas a página do Instagram ainda não foi atribuída no Genna"
      : perfil.slice(0, 120) };
  }

  const ultimoDia = new Date(Date.UTC(+mes.slice(0, 4), +mes.slice(5, 7), 0)).getUTCDate();
  const postsMes = listaDe(await chamar(key, "get_analytics_posts", {
    brandId: brand.id, limit: 100,
    publishedFrom: `${mes}-01T00:00:00Z`, publishedTo: `${mes}-${ultimoDia}T23:59:59Z`,
  }));
  const postsTri = listaDe(await chamar(key, "get_analytics_posts", {
    brandId: brand.id, limit: 100,
    publishedFrom: `${triDe}T00:00:00Z`, publishedTo: `${triAte}T23:59:59Z`,
  }));

  const alcancePorFormato = {};
  for (const p of postsTri) {
    const t = { FEED_CAROUSEL: "Carrossel", REEL: "Reels", FEED_SINGLE_IMAGE: "Imagem" }[p.type] || p.type;
    alcancePorFormato[t] = (alcancePorFormato[t] || 0) + (p.reach || 0);
  }
  const totalAlcance = Object.values(alcancePorFormato).reduce((s, x) => s + x, 0);

  return {
    brand: brand.id,
    marca: brand.name,
    handle: perfil?.username ? `@${perfil.username}` : null,
    seguidores: perfil?.followers ?? null,
    publicacoes_perfil: perfil?.mediaCount ?? null,
    mes: { periodo: mes, ...resume(postsMes), top: topPosts(postsMes, 3) },
    trimestre: {
      periodo: `${triDe} a ${triAte}`, ...resume(postsTri), top: topPosts(postsTri, 5),
      alcance_por_formato: Object.fromEntries(
        Object.entries(alcancePorFormato)
          .map(([k, v]) => [k, totalAlcance ? Math.round((v / totalAlcance) * 1000) / 10 : 0])
          .sort((a, b) => b[1] - a[1])
      ),
    },
  };
}

/**
 * Percorre TODAS as marcas da conta e devolve um perfil por marca que tenha
 * página atribuída. Marcas sem página entram na lista com o motivo, para o
 * painel poder dizer o que falta em vez de ficar em silêncio.
 * Devolve null (sem quebrar o sync) se a chave faltar ou o serviço não responder.
 */
export async function coletarGenna({ key, mes, triDe, triAte }) {
  if (!key) return null;
  try {
    await rpc(key, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "painel-staffcom", version: "1.0" },
    });
    await fetch(URL, {
      method: "POST", headers: headers(key),
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }),
    });

    const marcas = await chamar(key, "list_brands");
    const lista = Array.isArray(marcas) ? marcas : marcas?.brands || [];
    if (!lista.length) return null;

    const perfis = [];
    for (const b of lista) {
      // o username vem da conta vinculada, mesmo quando a página não foi atribuída
      const contas = await chamar(key, "list_social_accounts", { brandId: b.id });
      const username = (contas?.accounts || [])[0]?.username || null;
      const r = await coletarMarca(key, b, { mes, triDe, triAte });
      perfis.push({ ...r, handle: r.handle || (username ? `@${username}` : null) });
    }
    return perfis;
  } catch (e) {
    console.warn("  (Genna falhou: " + e.message + ")");
    return null;
  }
}
