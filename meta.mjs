/**
 * meta.mjs — leitura direta da Graph API da Meta, no lugar do Genna.
 *
 * O Genna era um intermediário pago para estes mesmos dados: ele lia a Graph API da
 * Meta e revendia. Com o crédito do teste esgotado, o painel passa a falar direto com
 * a fonte — de graça, sem limite mensal de consultas, com intervalo de datas exato e
 * alcançando TODOS os perfis da conta (o Genna só enxergava 2 dos 7).
 *
 * Precisa de META_TOKEN no .env (e no Secret do repositório). O token é de "usuário de
 * sistema", que não expira; token comum de usuário morre em 60 dias e quebraria o painel
 * caladamente. Sem o token, o sync segue sem a parte do Instagram.
 *
 * A forma do que sai daqui é igual à do genna.mjs de propósito: o sync e o template não
 * precisam saber de onde vieram os números.
 */

const API = `https://graph.facebook.com/${process.env.META_VERSAO || "v23.0"}`;

/** Troca qualquer coisa com cara de token por "[chave]". */
const semSegredo = (texto) => (texto || "").replace(/\bEAA[A-Za-z0-9]{20,}/g, "[chave]");

async function graph(token, caminho, params = {}) {
  const url = new URL(API + caminho);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  url.searchParams.set("access_token", token);

  const r = await fetch(url);
  const j = await r.json().catch(() => null);
  if (!r.ok || j?.error) {
    const e = j?.error || {};
    // A Meta devolve o token DENTRO do texto do erro ("Malformed access token EAA...").
    // Como isto roda no Actions, cujo log é público, a chave é apagada antes de virar texto.
    const erro = new Error(semSegredo(e.message) || `Meta ${caminho} -> ${r.status}`);
    erro.codigo = e.code;
    throw erro;
  }
  return j;
}

/** Percorre as páginas de um edge até acabar (ou até o teto, para não girar à toa). */
async function todas(token, caminho, params, teto = 400) {
  const itens = [];
  let pagina = await graph(token, caminho, { ...params, limit: 100 });
  while (true) {
    itens.push(...(pagina.data || []));
    const proxima = pagina.paging?.next;
    if (!proxima || itens.length >= teto) break;
    const r = await fetch(proxima);
    pagina = await r.json();
    if (pagina.error) break;
  }
  return itens;
}

// ---- métricas por publicação ----------------------------------------------------

// Reels e feed não aceitam exatamente o mesmo conjunto. Pede-se o maior que cada um
// aceita; se a Meta recusar, cai para o mínimo que existe em tudo.
const METRICAS = "reach,saved,shares,total_interactions,views";
const METRICAS_MIN = "reach";

/**
 * Busca insights de várias publicações numa tacada só (`?ids=`), em lotes de 25.
 * Um lote que falha é refeito item a item: uma publicação sem métrica não pode
 * derrubar o mês inteiro.
 */
async function insights(token, ids) {
  const mapa = new Map();
  const lotes = [];
  for (let i = 0; i < ids.length; i += 25) lotes.push(ids.slice(i, i + 25));

  for (const lote of lotes) {
    try {
      const r = await graph(token, "/", { ids: lote.join(","), fields: `insights.metric(${METRICAS})` });
      for (const [id, v] of Object.entries(r)) mapa.set(id, achata(v.insights));
    } catch {
      for (const id of lote) {
        for (const m of [METRICAS, METRICAS_MIN]) {
          try {
            const r = await graph(token, `/${id}/insights`, { metric: m });
            mapa.set(id, achata(r));
            break;
          } catch { /* tenta o conjunto menor; se nem esse vier, fica sem */ }
        }
      }
    }
  }
  return mapa;
}

const achata = (insights) =>
  Object.fromEntries((insights?.data || []).map((m) => [m.name, m.values?.[0]?.value ?? 0]));

// ---- formatação ------------------------------------------------------------------

/** Mesmos rótulos que o painel já usa, para o template não mudar. */
function formato(m) {
  if (m.media_product_type === "REELS") return "Reels";
  if (m.media_product_type === "STORY") return "Story";
  if (m.media_type === "CAROUSEL_ALBUM") return "Carrossel";
  return "Imagem";
}

/**
 * Um título para a publicação, no lugar da legenda cortada no meio.
 *
 * O Instagram não tem campo de título, então o mais próximo é a primeira frase da
 * legenda — que quase sempre é a chamada do post. Corta na primeira pontuação forte,
 * tira hashtags e devolve algo que se lê como manchete.
 */
function resumoLegenda(caption) {
  const limpo = (caption || "").replace(/#[\wÀ-ÿ]+/g, "").replace(/\s+/g, " ").trim();
  if (!limpo) return "";
  const frase = (limpo.match(/^(.{15,110}?)(?:[.!?:]|$)/) || [null, limpo])[1].trim();
  const t = frase.length >= 15 ? frase : limpo;
  return t.length > 110 ? t.slice(0, 108).trimEnd() + "…" : t;
}

function resume(posts) {
  const s = (k) => posts.reduce((t, p) => t + (p[k] || 0), 0);
  const alcance = s("alcance");
  const views = s("views");
  const interacoes = s("interacoes");
  return {
    publicacoes: posts.length,
    alcance,
    views,
    likes: s("likes"),
    comentarios: s("comentarios"),
    compartilhamentos: s("compartilhamentos"),
    salvamentos: s("salvamentos"),
    interacoes,
    // Engajamento mede-se contra VIEWS, não alcance. Em Reels, a Meta conta no alcance
    // só a distribuição própria da conta, enquanto views e curtidas contam a circulação
    // inteira — dividir por alcance produzia taxas de 300%.
    taxa_engajamento: views ? Math.round((interacoes / views) * 1000) / 10 : null,
    por_formato: posts.reduce((acc, p) => {
      acc[p.tipo] = (acc[p.tipo] || 0) + 1;
      return acc;
    }, {}),
  };
}

// Ordena por VIEWS. Ordenar por alcance invertia o ranking: um reels de 577 mil views
// perdia para um de 15 mil, porque o alcance de Reels não acompanha a circulação real.
const topPosts = (posts, n) =>
  [...posts].sort((a, b) => (b.views || 0) - (a.views || 0)).slice(0, n).map((p) => ({
    data: p.data,
    tipo: p.tipo,
    titulo: p.titulo,
    link: p.link,
    views: p.views,
    alcance: p.alcance,
    interacoes: p.interacoes,
    taxa: p.views ? Math.round((p.interacoes / p.views) * 1000) / 10 : null,
    salvamentos: p.salvamentos,
    compartilhamentos: p.compartilhamentos,
    // URL assinada e temporária: o sync baixa e embute a imagem antes que ela expire.
    thumb_url: p.thumb_url,
  }));

// ---- coleta por perfil -----------------------------------------------------------

const CAMPOS_MIDIA =
  "id,caption,media_type,media_product_type,permalink,thumbnail_url,media_url,timestamp,like_count,comments_count";

async function coletarPerfil(token, { pagina, ig }, { mes, triDe, triAte }) {
  const brutas = await todas(token, `/${ig.id}/media`, {
    fields: CAMPOS_MIDIA,
    since: Math.floor(Date.parse(`${triDe}T00:00:00Z`) / 1000),
    until: Math.floor(Date.parse(`${triAte}T23:59:59Z`) / 1000),
  });

  // O since/until do edge é uma dica, não uma garantia: confere pela data mesmo.
  const dentro = brutas.filter((m) => {
    const d = m.timestamp.slice(0, 10);
    return d >= triDe && d <= triAte;
  });

  const metricas = await insights(token, dentro.map((m) => m.id));

  const posts = dentro.map((m) => {
    const i = metricas.get(m.id) || {};
    const likes = m.like_count || 0;
    const comentarios = m.comments_count || 0;
    return {
      data: m.timestamp.slice(0, 10),
      tipo: formato(m),
      titulo: resumoLegenda(m.caption),
      link: m.permalink,
      alcance: i.reach || 0,
      views: i.views || 0,
      likes,
      comentarios,
      compartilhamentos: i.shares || 0,
      salvamentos: i.saved || 0,
      // total_interactions já soma likes + comentários + salvos + compartilhados;
      // quando a Meta não devolve (post antigo, formato sem a métrica), soma-se à mão.
      interacoes: i.total_interactions ?? (likes + comentarios + (i.saved || 0) + (i.shares || 0)),
      thumb_url: m.thumbnail_url || m.media_url || null,
    };
  });

  const doMes = posts.filter((p) => p.data.slice(0, 7) === mes);

  // Participação por formato também em views, pelo mesmo motivo do ranking.
  const alcancePorFormato = {};
  for (const p of posts) alcancePorFormato[p.tipo] = (alcancePorFormato[p.tipo] || 0) + (p.views || 0);
  const totalAlcance = Object.values(alcancePorFormato).reduce((s, x) => s + x, 0);

  // Agregados que alimentam as recomendações. Ficam aqui porque dependem da publicação
  // individual, que não sobrevive à saída desta função.
  // As listas de views vão inteiras: quem analisa precisa da mediana, e média já
  // guardada não dá para destrinchar depois. Dois virais distorcem qualquer média.
  const porFormato = {};
  for (const p of posts) (porFormato[p.tipo] ||= { views: [] }).views.push(p.views || 0);

  const porDia = Array.from({ length: 7 }, () => ({ views_lista: [] }));
  for (const p of posts) {
    // Data sem hora é lida como UTC; para dia da semana isso basta e evita fuso.
    porDia[new Date(`${p.data}T12:00:00Z`).getUTCDay()].views_lista.push(p.views || 0);
  }

  return {
    brand: ig.id,
    marca: pagina.name,
    analise: {
      ultima_publicacao: posts.length ? posts.map((p) => p.data).sort().at(-1) : null,
      formato: porFormato,
      dia_semana: porDia,
    },
    handle: ig.username ? `@${ig.username}` : null,
    seguidores: ig.followers_count ?? null,
    publicacoes_perfil: ig.media_count ?? null,
    mes: { periodo: mes, ...resume(doMes), top: topPosts(doMes, 3) },
    trimestre: {
      periodo: `${triDe} a ${triAte}`, ...resume(posts), top: topPosts(posts, 5),
      alcance_por_formato: Object.fromEntries(
        Object.entries(alcancePorFormato)
          .map(([k, v]) => [k, totalAlcance ? Math.round((v / totalAlcance) * 1000) / 10 : 0])
          .sort((a, b) => b[1] - a[1])
      ),
    },
  };
}

/**
 * Percorre todas as Páginas que o token alcança e devolve um perfil por conta do
 * Instagram conectada. Página sem Instagram entra na lista com o motivo, para o
 * painel poder dizer o que falta em vez de ficar em silêncio.
 * Devolve null (sem quebrar o sync) se o token faltar ou a Meta não responder.
 */
export async function coletarMeta({ token, mes, triDe, triAte }) {
  if (!token) return null;
  try {
    const paginas = await todas(token, "/me/accounts", {
      fields: "name,instagram_business_account{id,username,followers_count,media_count}",
    });
    if (!paginas.length) return null;

    const perfis = [];
    for (const pagina of paginas) {
      const ig = pagina.instagram_business_account;
      if (!ig) {
        perfis.push({ marca: pagina.name, handle: null,
          erro: "a Página não tem conta do Instagram conectada (ou não foi atribuída ao usuário de sistema)" });
        continue;
      }
      try {
        perfis.push(await coletarPerfil(token, { pagina, ig }, { mes, triDe, triAte }));
      } catch (e) {
        perfis.push({ brand: ig.id, marca: pagina.name,
          handle: ig.username ? `@${ig.username}` : null, erro: e.message.slice(0, 160) });
      }
    }
    return perfis;
  } catch (e) {
    console.warn("  (Meta falhou: " + semSegredo(e.message) + ")");
    return null;
  }
}
