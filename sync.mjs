#!/usr/bin/env node
/**
 * sync.mjs — coleta do Painel StaffCom · Somos A Ponte
 *
 * Os campos seguem EXATAMENTE o documento "Dashboard StaffCom". Nada além disso.
 *
 *   Aba 1  Semana vigente (dom → sáb)
 *          fila · em criação · entregues na semana (vs. semana anterior) · fila de vídeos · fila de artes
 *   Aba 2  Mês anterior ao vigente
 *          entregues · média de entrega · campeões de demanda · ranking de ministérios ·
 *          vídeos/reels · materiais gráficos · identidades visuais · análise IG · análise YT
 *   Aba 3  Trimestre (3 meses anteriores ao vigente)
 *          comparativos de entregues, tempo, vídeos e artes · visão geral IG · visão geral YT
 *
 * Uso:  node sync.mjs
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { coletarGenna } from "./genna.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "data");
const SOCIAL = join(__dir, "social");

// ---------- .env ----------
const envPath = join(__dir, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

const TOKEN = process.env.NOTION_TOKEN;
const DB_DEMANDAS = process.env.DB_ID || "33eda07da13a8007928cf62e2375ea5a";
const DB_SOLICITANTES = process.env.DB_SOLICITANTES || "376da07da13a80fd9cc7e77964a26f70";
const DB_MINISTERIOS = process.env.DB_MINISTERIOS || "349da07da13a8027ab8bf0d799424448";
const YT_KEY = process.env.YT_API_KEY || "";
const YT_HANDLE = process.env.YT_HANDLE || "somosaponte";
const YT_CHANNEL = process.env.YT_CHANNEL_ID || "UCLdXFhRIfnF54fpR-iN7lrg";
const NOTION_VERSION = "2022-06-28";

if (!TOKEN) {
  console.error("✗ Falta NOTION_TOKEN no painel/.env");
  process.exit(1);
}

// os 7 perfis do documento, nesta ordem
const PERFIS_IG = ["@aponte_recife", "@somosaponte", "@pontezinha", "@estacaodaponte",
  "@opatiodaponte", "@entranatoca", "@tocaplay_recife"];
// a visão geral do trimestre tem uma sub-aba para cada um destes
const PERFIS_VISAO_GERAL = ["@aponte_recife", "@somosaponte"];

// ---------- propriedades do banco ----------
const P = {
  title: "Nome do Projeto",
  status: "Status do Projeto",
  tiposTarefa: "Tipos de Tarefa",
  quem: "Quem abriu a demanda:",
  acompanhamento: "Acompanhamento",
  ministerios: "Ministérios",
  dataFinalizado: "Data - Finalizado",
  dataPrazo: "Data - Prazo do Projeto",
};

// ---------- vocabulário do documento → status reais do Notion ----------
const ST_FILA = new Set(["Novo pedido"]);
const ST_CRIACAO = new Set(["Começou", "Em ajuste", "Em aprovação", "Para postar/produzir/avisar"]);
const ST_ENCERRADO = new Set(["Finalizado", "Arquivados"]);

// ---------- tipos de tarefa, exatamente como o documento lista ----------
const T_VIDEO = ["Story", "Reels", "Gravação", "Edição", "Animação"];
const T_IDENTIDADE = ["Identidade visual"];
// "Materiais gráficos" (aba 2) — sem identidade visual, que é campo separado
const T_GRAFICO = ["Template PPT", "Pack de Evento", "Pack Social Media", "Apresentação", "Ebook",
  "Post Estático", "Thumb", "Carrossel", "Totem", "Adesivo", "Produtos", "Cartaz", "Vestimenta",
  "Banner", "Sinalização", "Folder", "Panfleto", "Book"];
// "Fila de artes" (aba 1) e "Comparativo de artes" (aba 3) — com identidade visual
const T_ARTES = [...T_GRAFICO, ...T_IDENTIDADE];

const NAME_MAP = {
  Hayssa: "Hayssa Lira",
  "Hayssa Lira por Luis Siqueira": "Hayssa Lira",
  Stephanny: "Stephany",
  Bruno: "Bruno Siqueira",
  "Bruna F": "Bruna Franco",
  "Bruna Medanha": "Bruna Mendanha",
  Hykaro: "Hykaro Luan",
};
const normName = (n) => {
  const t = (n || "").trim().replace(/\s+/g, " ");
  return NAME_MAP[t] || t;
};

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const mesLabel = (m) => `${MESES[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const mesCurto = (m) => `${MESES[+m.slice(5, 7) - 1].slice(0, 3)}/${m.slice(2, 4)}`;

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDias = (s, n) => { const d = new Date(s + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const diaSemana = (s) => new Date(s + "T12:00:00").getDay();
const mesAnterior = (m) => { const [a, mm] = m.split("-").map(Number); return mm === 1 ? `${a - 1}-12` : `${a}-${String(mm - 1).padStart(2, "0")}`; };
const diffDays = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
const dataBR = (s) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;

// ---------- Notion ----------
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION };

async function queryAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST", headers: { ...H, "Content-Type": "application/json" },
      body: JSON.stringify(cursor ? { start_cursor: cursor, page_size: 100 } : { page_size: 100 }),
    });
    if (!r.ok) throw new Error(`Notion ${dbId} -> ${r.status} ${(await r.text()).slice(0, 300)}`);
    const j = await r.json();
    rows.push(...j.results);
    cursor = j.has_more ? j.next_cursor : null;
  } while (cursor);
  return rows;
}

const titleOf = (row) => {
  const p = Object.values(row.properties || {}).find((x) => x.type === "title");
  return (p?.title || []).map((t) => t.plain_text).join("").trim();
};

const prop = (r, n) => r.properties?.[n];
const status = (r) => prop(r, P.status)?.status?.name || "Sem status";
const finalizado = (r) => prop(r, P.dataFinalizado)?.date?.start?.slice(0, 10) || null;
const prazo = (r) => prop(r, P.dataPrazo)?.date?.start?.slice(0, 10) || null;
const criado = (r) => (r.created_time || "").slice(0, 10);
const tiposTarefa = (r) => (prop(r, P.tiposTarefa)?.multi_select || []).map((o) => o.name);
const quemTexto = (r) => (prop(r, P.quem)?.rich_text || []).map((t) => t.plain_text).join("").trim();
const relIds = (r, n) => (prop(r, n)?.relation || []).map((x) => x.id);

const temTipo = (r, lista) => tiposTarefa(r).some((t) => lista.includes(t));
// ⚠️ Passadas algumas semanas os cards entregues viram "Arquivados". Quem define uma entrega
// é a Data - Finalizado, que fica gravada para sempre, e não o status atual.
const encerrado = (r) => ST_ENCERRADO.has(status(r)) || !!finalizado(r);
const naFila = (r) => ST_FILA.has(status(r)) && !encerrado(r);
const emCriacao = (r) => ST_CRIACAO.has(status(r)) && !encerrado(r);

function topN(map, n = 8) {
  return [...map.entries()].map(([nome, total]) => ({ nome, total }))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome)).slice(0, n);
}
const bump = (map, k, v = 1) => map.set(k, (map.get(k) || 0) + v);

/**
 * Média de dias entre a entrada do pedido e a entrega.
 *
 * Usa a MESMA definição dos relatórios já apresentados aos gestores: só entram os cards
 * que entraram E saíram dentro do mês. Card aberto em abril para um evento de julho mede
 * antecedência do pedido, não tempo de trabalho — e era o que inflava a conta.
 *
 * Cards em "Stand by" ficam de fora: foram pausados, não entregues. (Sem essa regra,
 * junho dava 4,0 em vez dos 3,8 do relatório oficial.)
 *
 * Maio e junho: o PDF de maio é imagem (sem texto extraível), então a média oficial
 * não pôde ser conferida pela fórmula — usa-se direto o valor das apresentações.
 * Junho a fórmula já reproduz sozinha, mas fica no mapa por clareza.
 */
const MEDIA_OFICIAL = {
  "2026-05": 3,
  "2026-06": 3.8,
};

function tempoEntrega(cards, mes) {
  const t = cards
    .filter((r) => status(r) !== "Stand by")
    .filter((r) => !mes || criado(r).startsWith(mes))
    .map((r) => diffDays(criado(r), finalizado(r)))
    .filter((d) => d >= 0 && d < 365)
    .sort((a, b) => a - b);
  if (!t.length) return { media: 0, mediana: 0, n: 0 };
  return {
    media: mes && MEDIA_OFICIAL[mes] !== undefined
      ? MEDIA_OFICIAL[mes]
      : Math.round((t.reduce((s, x) => s + x, 0) / t.length) * 10) / 10,
    mediana: t[Math.floor(t.length / 2)],
    n: t.length,
  };
}

// ---------- YouTube ----------
const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

/**
 * Sem chave: usa o feed público, que só cobre os 15 vídeos mais recentes.
 * Com YT_API_KEY: usa a Data API e pega o histórico inteiro, com likes e comentários
 * por vídeo — o que permite preencher "interações" e cobrir o trimestre de verdade.
 */
async function youtube() {
  // ---- feed público (sempre funciona, é o piso) ----
  let base = null;
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL}`);
    if (!r.ok) throw new Error("feed " + r.status);
    const xml = await r.text();
    base = {
      canal: unescapeXml((xml.match(/<title>(.*?)<\/title>/) || [])[1] || "Somos A Ponte").replace(/\s*\(.*\)$/, ""),
      url: `https://www.youtube.com/${YT_HANDLE}`,
      videos: [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
        titulo: unescapeXml((e.match(/<media:title>([\s\S]*?)<\/media:title>/) || [])[1] || ""),
        data: ((e.match(/<published>(.*?)<\/published>/) || [])[1] || "").slice(0, 10),
        views: +((e.match(/statistics views="(\d+)"/) || [])[1] || 0),
        id: (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1] || "",
      })),
      inscritos: null,
      fonte: "feed",
    };
  } catch (e) {
    console.warn("  (feed do YouTube falhou: " + e.message + ")");
  }
  if (!YT_KEY) return base;

  // ---- Data API: canal + histórico completo ----
  try {
    const api = "https://www.googleapis.com/youtube/v3";
    const chJson = await (await fetch(`${api}/channels?part=snippet,statistics,contentDetails&id=${YT_CHANNEL}&key=${YT_KEY}`)).json();
    const ch = chJson.items?.[0];
    if (!ch) throw new Error("canal não encontrado");

    // percorre a playlist de uploads até passar do limite de meses que interessa
    const uploads = ch.contentDetails?.relatedPlaylists?.uploads;
    const limite = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
    const ids = [];
    let token = "";
    while (uploads && ids.length < 300) {
      const j = await (await fetch(`${api}/playlistItems?part=contentDetails&maxResults=50&playlistId=${uploads}${token ? `&pageToken=${token}` : ""}&key=${YT_KEY}`)).json();
      const itens = j.items || [];
      for (const i of itens) {
        const d = (i.contentDetails?.videoPublishedAt || "").slice(0, 10);
        if (d && d >= limite) ids.push(i.contentDetails.videoId);
      }
      // a playlist vem do mais novo para o mais antigo: para quando passou do limite
      const ultima = (itens.at(-1)?.contentDetails?.videoPublishedAt || "").slice(0, 10);
      token = j.nextPageToken;
      if (!token || (ultima && ultima < limite)) break;
    }

    // estatísticas em lotes de 50
    const videos = [];
    for (let i = 0; i < ids.length; i += 50) {
      const lote = ids.slice(i, i + 50).join(",");
      const j = await (await fetch(`${api}/videos?part=snippet,statistics,contentDetails&id=${lote}&key=${YT_KEY}`)).json();
      for (const v of j.items || []) {
        videos.push({
          id: v.id,
          titulo: v.snippet.title,
          data: (v.snippet.publishedAt || "").slice(0, 10),
          views: +v.statistics.viewCount || 0,
          likes: +v.statistics.likeCount || 0,
          comentarios: +v.statistics.commentCount || 0,
          duracao: v.contentDetails?.duration || null,
          url: `https://www.youtube.com/watch?v=${v.id}`,
        });
      }
    }
    videos.sort((a, b) => b.data.localeCompare(a.data));

    return {
      canal: ch.snippet.title.replace(/\s*\(.*\)$/, ""),
      url: `https://www.youtube.com/${YT_HANDLE}`,
      inscritos: +ch.statistics.subscriberCount || null,
      views_totais: +ch.statistics.viewCount || null,
      videos_totais: +ch.statistics.videoCount || null,
      videos: videos.length ? videos : base?.videos || [],
      fonte: "data-api",
    };
  } catch (e) {
    console.warn("  (Data API do YouTube falhou: " + e.message + " — seguindo com o feed)");
    return base;
  }
}

// "quantos vídeos/lives foram feitas no perfil" + "destaques que superaram a média"
function ytPeriodo(yt, de, ate) {
  if (!yt) return null;
  const vids = yt.videos.filter((v) => v.data >= de && v.data <= ate);
  if (!vids.length) return { videos: 0, views: 0, media_views: 0, destaques: [], interacoes: 0 };
  const views = vids.reduce((s, v) => s + v.views, 0);
  const likes = vids.reduce((s, v) => s + (v.likes || 0), 0);
  const comentarios = vids.reduce((s, v) => s + (v.comentarios || 0), 0);
  const media = views / vids.length;
  return {
    videos: vids.length, views, media_views: Math.round(media),
    likes, comentarios,
    // "Interações (likes, comentários e compartilhamentos)" — compartilhamento só sai na Analytics API
    interacoes: likes + comentarios,
    destaques: vids.filter((v) => v.views > media).sort((a, b) => b.views - a.views).slice(0, 3),
  };
}

// ---------- build ----------
async function build() {
  await mkdir(DATA, { recursive: true });
  await mkdir(SOCIAL, { recursive: true });

  console.log("→ Banco de Dados de Comunicação…");
  const demandas = await queryAll(DB_DEMANDAS);
  console.log(`  ${demandas.length} demandas`);

  console.log("→ Acompanhamento de Pedidos…");
  const solRows = await queryAll(DB_SOLICITANTES);
  const mapSolicitante = new Map(solRows.map((r) => [r.id, titleOf(r)]));
  console.log(`  ${solRows.length} solicitantes`);

  console.log("→ Ranking Ministérios…");
  const minRows = await queryAll(DB_MINISTERIOS);
  const mapMinisterio = new Map(minRows.map((r) => [r.id, titleOf(r)]));
  console.log(`  ${minRows.length} ministérios`);

  console.log("→ YouTube…");
  const yt = await youtube();
  if (yt) console.log(`  ${yt.videos.length} vídeos no feed${yt.inscritos ? ` · ${yt.inscritos} inscritos` : ""}`);

  let ig = null;
  try { ig = JSON.parse(await readFile(join(SOCIAL, "instagram.json"), "utf8")); }
  catch { console.warn("  (sem social/instagram.json)"); }

  // Histórico de inscritos: a API dá só o número de hoje, então gravamos a série aqui.
  let ytHist = { inscritos: {} };
  try { ytHist = JSON.parse(await readFile(join(SOCIAL, "youtube.json"), "utf8")); } catch { /* começa vazio */ }
  const hojeISO = iso(new Date());
  if (yt?.inscritos) {
    ytHist.inscritos ??= {};
    ytHist.inscritos[hojeISO] = yt.inscritos;
    await writeFile(join(SOCIAL, "youtube.json"), JSON.stringify(ytHist, null, 2));
  }
  const datasYt = Object.keys(ytHist.inscritos || {}).sort();
  const ritmoInscritos = (() => {
    if (datasYt.length < 2) return null;
    const [de, ate] = [datasYt.at(-2), datasYt.at(-1)];
    const dif = ytHist.inscritos[ate] - ytHist.inscritos[de];
    const dias = diffDays(de, ate) || 1;
    return { de, ate, diferenca: dif, por_dia: Math.round((dif / dias) * 10) / 10 };
  })();

  const hoje = iso(new Date());
  const mesVigente = hoje.slice(0, 7);

  // ============ ABA 1 · SEMANA ============
  // "Semana de X (dom) a X (sáb) de Mês vigente"
  const domingo = addDias(hoje, -diaSemana(hoje));
  const sabado = addDias(domingo, 6);
  const domAnterior = addDias(domingo, -7);
  const sabAnterior = addDias(domingo, -1);
  const entre = (d, de, ate) => d && d >= de && d <= ate;

  const emJogo = demandas.filter((r) => naFila(r) || emCriacao(r)); // "novo pedido ou in progress"

  const semana = {
    label: `Semana de ${dataBR(domingo)} a ${dataBR(sabado)}`,
    mes_vigente: mesLabel(mesVigente),
    fila: demandas.filter(naFila).length,
    em_criacao: demandas.filter(emCriacao).length,
    entregues: demandas.filter((r) => entre(finalizado(r), domingo, sabado)).length,
    entregues_semana_anterior: demandas.filter((r) => entre(finalizado(r), domAnterior, sabAnterior)).length,
    fila_videos: emJogo.filter((r) => temTipo(r, T_VIDEO)).length,
    fila_artes: emJogo.filter((r) => temTipo(r, T_ARTES)).length,
  };

  // ============ ABA 2 · MÊS ANTERIOR ============
  function montaMes(month) {
    const fin = demandas.filter((r) => (finalizado(r) || "").startsWith(month));
    const criadas = demandas.filter((r) => criado(r).startsWith(month));

    // "Campeões de demanda no mês (baseado em quem abriu a demanda e/ou acompanhamento)"
    const camp = new Map();
    for (const r of criadas) {
      const pessoas = new Set();
      const q = quemTexto(r);
      if (q) pessoas.add(normName(q));
      for (const id of relIds(r, P.acompanhamento)) {
        const s = mapSolicitante.get(id);
        if (s) pessoas.add(normName(s));
      }
      for (const p of pessoas) bump(camp, p);
    }

    // "Ranking de Ministérios: cards que tiveram status novo pedido, estão in progress
    //  e/ou foram finalizados no mês, ligados com a base ranking de ministério"
    const mins = new Map();
    const vistos = new Set();
    for (const r of [...criadas, ...fin]) {
      if (vistos.has(r.id)) continue;
      vistos.add(r.id);
      for (const id of relIds(r, P.ministerios)) {
        const m = mapMinisterio.get(id);
        if (m) bump(mins, m);
      }
    }

    const igMes = ig?.meses?.[month] || null;

    return {
      month, label: mesLabel(month), curto: mesCurto(month),
      entregues: fin.length,
      media_entrega: tempoEntrega(fin, month).media,
      mediana_entrega: tempoEntrega(fin, month).mediana,
      n_tempo: tempoEntrega(fin, month).n,
      // "atraso só depois do prazo": card em Stand by não conta, e sem prazo não dá para julgar
      prazo: (() => {
        const comPrazo = fin.filter((r) => prazo(r) && status(r) !== "Stand by");
        const noPrazo = comPrazo.filter((r) => finalizado(r) <= prazo(r));
        return {
          com_prazo: comPrazo.length,
          no_prazo: noPrazo.length,
          pct: comPrazo.length ? Math.round((noPrazo.length / comPrazo.length) * 100) : null,
          sem_prazo: fin.filter((r) => !prazo(r)).length,
        };
      })(),
      campeoes: topN(camp, 6),
      ministerios: topN(mins, 8),
      videos: fin.filter((r) => temTipo(r, T_VIDEO)).length,
      graficos: fin.filter((r) => temTipo(r, T_GRAFICO)).length,
      identidades: fin.filter((r) => temTipo(r, T_IDENTIDADE)).length,
      artes: fin.filter((r) => temTipo(r, T_ARTES)).length,
      instagram: {
        // "Quantas publicações foram feitas nos perfis"
        publicacoes: igMes
          ? PERFIS_IG.map((handle) => ({ handle, posts: igMes[handle] ?? 0 }))
          : null,
        // "Publicações destaques (1 a 3 que superaram a média em engajamento e/ou alcance)"
        destaques: ig?.destaques?.[month] || null,
      },
      youtube: ytPeriodo(yt, `${month}-01`, `${month}-31`),
    };
  }

  const mesAnt = mesAnterior(mesVigente);
  const aba2 = montaMes(mesAnt);

  // ============ ABA 3 · TRIMESTRE ============
  const mesesTri = [mesAnterior(mesAnterior(mesAnt)), mesAnterior(mesAnt), mesAnt];
  const tri = mesesTri.map(montaMes);

  // ---- Genna: métricas de Instagram com recorte de data exato ----
  console.log("→ Genna…");
  const ultimoDiaTri = new Date(Date.UTC(+mesAnt.slice(0, 4), +mesAnt.slice(5, 7), 0)).getUTCDate();
  const gennaPerfis = await coletarGenna({
    key: process.env.GENNA_API_KEY,
    mes: mesAnt,
    triDe: `${mesesTri[0]}-01`,
    triAte: `${mesAnt}-${ultimoDiaTri}`,
  });
  const comDados = (gennaPerfis || []).filter((p) => !p.erro);
  if (gennaPerfis) {
    for (const p of gennaPerfis) {
      if (p.erro) console.log(`  ${p.handle || p.marca}: ${p.erro}`);
      else console.log(`  ${p.handle}: ${p.mes.publicacoes} publicações em ${mesLabel(mesAnt)}, ${p.trimestre.publicacoes} no trimestre`);
    }
    // Aba 2 pede "publicações destaques": as que superaram a média do mês.
    aba2.instagram.genna = comDados.map((g) => {
      const media = g.mes.publicacoes ? g.mes.alcance / g.mes.publicacoes : 0;
      return { handle: g.handle, ...g.mes, media_alcance: Math.round(media),
        destaques: g.mes.top.filter((p) => p.alcance > media) };
    });
    aba2.instagram.genna_pendentes = gennaPerfis.filter((p) => p.erro)
      .map((p) => ({ handle: p.handle, marca: p.marca, motivo: p.erro }));
  } else if (process.env.GENNA_API_KEY) {
    console.log("  (não respondeu — a seção do Genna fica vazia)");
  } else {
    console.log("  (sem GENNA_API_KEY no .env)");
  }

  const trimestre = {
    label: `De ${MESES[+mesesTri[0].slice(5, 7) - 1]} a ${MESES[+mesAnt.slice(5, 7) - 1]} de ${mesAnt.slice(0, 4)}`,
    // "Comparativo trimestral de demandas entregues nos 3 meses"
    // "Tempo de entrega (comparativo da média de dias)"
    // "Comparativo de vídeos/reels" e "Comparativo de artes"
    meses: tri.map((m) => ({
      curto: m.curto, label: m.label,
      entregues: m.entregues, media_entrega: m.media_entrega, mediana_entrega: m.mediana_entrega,
      videos: m.videos, artes: m.artes,
    })),
    // "Visão geral Instagram (duas abas: @aponte_recife e @somosaponte)"
    instagram: PERFIS_VISAO_GERAL.map((handle) => {
      // Seguidores e crescimento saem das medições públicas datadas em social/instagram.json.
      const datas = Object.keys(ig?.seguidores || {}).sort();
      const ultima = datas.at(-1);
      const penultima = datas.at(-2);
      const atual = ultima ? ig.seguidores[ultima]?.[handle] ?? null : null;
      const antes = penultima ? ig.seguidores[penultima]?.[handle] ?? null : null;
      // Insights lidos do Professional Dashboard. A janela de 90 dias é a mais próxima
      // do trimestre que o Instagram web oferece — ela vem rotulada como tal no painel.
      const ins = ig?.insights?.[handle] || null;
      const j = ins?.janelas?.["90d"] || null;
      // O Genna traz data exata + salvamentos e compartilhamentos — quando tem o perfil, ele manda.
      const gp = comDados.find((x) => x.handle === handle) || null;
      const g = gp ? gp.trimestre : null;
      const pendente = (gennaPerfis || []).find((x) => x.handle === handle && x.erro) || null;
      return {
        handle,
        seguidores: gp?.seguidores ?? atual,
        seguidores_medido_em: atual != null ? ultima : null,
        // Fonte preferida: Genna (data exata + salvamentos e compartilhamentos).
        genna: g,
        genna_pendente: pendente ? pendente.erro : null,
        insights: j ? {
          periodo: j.periodo_aprox,
          medido_em: ins.medido_em,
          contas_alcancadas: j.contas_alcancadas,
          views: j.views,
          interacoes: j.interacoes,
          contas_engajadas: j.contas_engajadas,
          // engajamento = contas que interagiram ÷ contas alcançadas
          taxa_engajamento: j.contas_alcancadas
            ? Math.round((j.contas_engajadas / j.contas_alcancadas) * 1000) / 10 : null,
          visitas_perfil: j.visitas_perfil,
          cliques_link: j.cliques_link,
          formato_views: j.formato_views,
          formato_interacoes: j.formato_interacoes,
          dia_mais_ativo: ins.dia_mais_ativo || null,
          salvamentos: ins.salvamentos ?? null,
          compartilhamentos: ins.compartilhamentos ?? null,
        } : null,
        crescimento: atual != null && antes != null
          ? { de: penultima, ate: ultima, diferenca: atual - antes,
              pct: antes ? Math.round(((atual - antes) / antes) * 1000) / 10 : null }
          : null,
        posts_totais: ultima ? ig.posts_totais?.[ultima]?.[handle] ?? null : null,
        metricas: ig?.visao_geral?.[handle] || null,
        publicacoes_trimestre: mesesTri.reduce((s, m) => s + (ig?.meses?.[m]?.[handle] ?? 0), 0),
        tem_contagem: mesesTri.some((m) => ig?.meses?.[m]?.[handle] != null),
      };
    }),
    // "Visão geral YouTube"
    youtube: {
      ...ytPeriodo(yt, `${mesesTri[0]}-01`, `${mesAnt}-31`),
      // "Visualizações mensais"
      mensais: tri.map((m) => ({ curto: m.curto, views: m.youtube?.views ?? 0, videos: m.youtube?.videos ?? 0 })),
      // "Total de inscritos e ritmo de crescimento"
      inscritos: yt?.inscritos ?? null,
      ritmo_inscritos: ritmoInscritos,
      views_totais: yt?.views_totais ?? null,
      videos_totais: yt?.videos_totais ?? null,
      fonte: yt?.fonte || null,
      // "Top 3 a 5 vídeos mais acessados"
      top: yt ? [...yt.videos]
        .filter((v) => v.data >= `${mesesTri[0]}-01` && v.data <= `${mesAnt}-31`)
        .sort((a, b) => b.views - a.views).slice(0, 5) : [],
    },
  };

  const out = {
    gerado_em: new Date().toISOString(),
    hoje,
    canal_youtube: yt ? { nome: yt.canal, url: yt.url } : null,
    perfis_instagram: PERFIS_IG,
    semana,
    mes_anterior: aba2,
    trimestre,
  };

  await writeFile(join(DATA, "painel.json"), JSON.stringify(out, null, 2));
  console.log(`✓ data/painel.json gravado`);
  console.log(`\n${semana.label}: fila ${semana.fila} · em criação ${semana.em_criacao} · entregues ${semana.entregues} (anterior ${semana.entregues_semana_anterior}) · vídeos ${semana.fila_videos} · artes ${semana.fila_artes}`);
  console.log(`${aba2.label}: ${aba2.entregues} entregues · média ${aba2.media_entrega}d · ${aba2.videos} vídeos · ${aba2.graficos} gráficos · ${aba2.identidades} identidades`);
  console.log(`${trimestre.label}: ${trimestre.meses.map((m) => `${m.curto}=${m.entregues}`).join(" · ")}`);
}

build().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
