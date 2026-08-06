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

// média de dias entre a entrada do pedido e a entrega
function mediaEntrega(cards) {
  const t = cards.map((r) => diffDays(criado(r), finalizado(r))).filter((d) => d >= 0 && d < 365);
  return t.length ? Math.round((t.reduce((s, x) => s + x, 0) / t.length) * 10) / 10 : 0;
}

// ---------- YouTube ----------
const unescapeXml = (s) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

async function youtube() {
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
      })),
      inscritos: null,
    };
  } catch (e) {
    console.warn("  (feed do YouTube falhou: " + e.message + ")");
    return null;
  }
  if (YT_KEY) {
    try {
      const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=statistics&id=${YT_CHANNEL}&key=${YT_KEY}`);
      const ch = (await r.json()).items?.[0];
      if (ch) base.inscritos = +ch.statistics.subscriberCount || null;
    } catch { /* segue sem inscritos */ }
  }
  return base;
}

// "quantos vídeos/lives foram feitas no perfil" + "destaques que superaram a média"
function ytPeriodo(yt, de, ate) {
  if (!yt) return null;
  const vids = yt.videos.filter((v) => v.data >= de && v.data <= ate);
  if (!vids.length) return { videos: 0, views: 0, media_views: 0, destaques: [] };
  const views = vids.reduce((s, v) => s + v.views, 0);
  const media = views / vids.length;
  return {
    videos: vids.length, views, media_views: Math.round(media),
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
      media_entrega: mediaEntrega(fin),
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

  const trimestre = {
    label: `De ${MESES[+mesesTri[0].slice(5, 7) - 1]} a ${MESES[+mesAnt.slice(5, 7) - 1]} de ${mesAnt.slice(0, 4)}`,
    // "Comparativo trimestral de demandas entregues nos 3 meses"
    // "Tempo de entrega (comparativo da média de dias)"
    // "Comparativo de vídeos/reels" e "Comparativo de artes"
    meses: tri.map((m) => ({
      curto: m.curto, label: m.label,
      entregues: m.entregues, media_entrega: m.media_entrega,
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
      return {
        handle,
        seguidores: atual,
        seguidores_medido_em: atual != null ? ultima : null,
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
