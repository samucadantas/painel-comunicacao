#!/usr/bin/env node
/**
 * sync.mjs — coleta do Painel StaffCom · Somos A Ponte
 *
 * Segue a estrutura definida em "Dashboard StaffCom":
 *   Aba 1  Semana vigente (dom → sáb)
 *   Aba 2  Mês anterior ao vigente
 *   Aba 3  Trimestre (3 meses anteriores ao vigente)
 *
 * Fontes:
 *   Notion — Banco de Dados de Comunicação, Acompanhamento de Pedidos, Ranking Ministérios
 *   YouTube — feed oficial do canal (sem chave) + Data API (opcional, traz inscritos)
 *   Instagram — social/instagram.json (contagem manual; a Graph API exige conta Business)
 *
 * Uso:  node sync.mjs
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const DATA = join(__dir, "data");
const SNAPS = join(DATA, "snapshots");
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

// ---------- propriedades do banco principal ----------
const P = {
  title: "Nome do Projeto",
  status: "Status do Projeto",
  tiposTarefa: "Tipos de Tarefa",
  tipoDemanda: "Tipo de Demanda",
  prioridade: "Prioridade",
  quem: "Quem abriu a demanda:",
  acompanhamento: "Acompanhamento",
  ministerios: "Ministérios",
  responsaveis: "Responsáveis",
  dataFinalizado: "Data - Finalizado",
  dataPrazo: "Data - Prazo do Projeto",
};

// ---------- vocabulário do documento → status reais do Notion ----------
// O documento fala em "novo pedido" e "in progress"; o banco tem uma lista maior.
const ST_FILA = new Set(["Novo pedido"]);
const ST_CRIACAO = new Set(["Começou", "Em ajuste", "Em aprovação", "Para postar/produzir/avisar"]);
const ST_ENCERRADO = new Set(["Finalizado", "Arquivados"]);
// Stand by / Calendário / Avisos não são fila nem produção: ficam num grupo à parte.

// ---------- tipos de tarefa, conforme o documento ----------
const T_VIDEO = ["Story", "Reels", "Gravação", "Edição", "Animação"];
const T_IDENTIDADE = ["Identidade visual"];
const T_GRAFICO = ["Template PPT", "Pack de Evento", "Pack Social Media", "Apresentação", "Ebook",
  "Post Estático", "Thumb", "Carrossel", "Totem", "Adesivo", "Produtos", "Cartaz", "Vestimenta",
  "Banner", "Sinalização", "Folder", "Panfleto", "Book"];
// "Fila de artes" (aba 1) inclui identidade visual junto dos gráficos.
const T_ARTES_FILA = [...T_GRAFICO, ...T_IDENTIDADE];

// Unifica variações de nome no ranking de solicitantes.
const NAME_MAP = {
  Hayssa: "Hayssa Lira",
  "Hayssa Lira por Luis Siqueira": "Hayssa Lira",
  Stephanny: "Stephany",
  Bruno: "Bruno Siqueira",
  "Bruna F": "Bruna Franco",
  "Bruna Medanha": "Bruna Mendanha",
  Hykaro: "Hykaro Luan",
};
const EXCLUDE = new Set([]);
const normName = (n) => {
  const t = (n || "").trim().replace(/\s+/g, " ");
  return NAME_MAP[t] || t;
};

const MESES = ["Janeiro","Fevereiro","Março","Abril","Maio","Junho","Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"];
const mesLabel = (m) => `${MESES[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const mesCurto = (m) => `${MESES[+m.slice(5, 7) - 1].slice(0, 3)}/${m.slice(2, 4)}`;

// ---------- datas (tudo em ISO local, sem fuso) ----------
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addDias = (isoStr, n) => { const d = new Date(isoStr + "T12:00:00"); d.setDate(d.getDate() + n); return iso(d); };
const diaSemana = (isoStr) => new Date(isoStr + "T12:00:00").getDay(); // 0 = domingo
const mesAnterior = (m) => { const [a, mm] = m.split("-").map(Number); return mm === 1 ? `${a - 1}-12` : `${a}-${String(mm - 1).padStart(2, "0")}`; };
const diffDays = (a, b) => Math.round((new Date(b + "T12:00:00") - new Date(a + "T12:00:00")) / 86400000);
const dataBR = (isoStr) => `${isoStr.slice(8, 10)}/${isoStr.slice(5, 7)}`;

// ---------- Notion ----------
const H = { Authorization: `Bearer ${TOKEN}`, "Notion-Version": NOTION_VERSION };

async function queryAll(dbId) {
  const rows = [];
  let cursor;
  do {
    const r = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: "POST",
      headers: { ...H, "Content-Type": "application/json" },
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

// ---------- leitores ----------
const prop = (r, n) => r.properties?.[n];
const nome = (r) => (prop(r, P.title)?.title || []).map((t) => t.plain_text).join("").trim();
const status = (r) => prop(r, P.status)?.status?.name || "Sem status";
const finalizado = (r) => prop(r, P.dataFinalizado)?.date?.start?.slice(0, 10) || null;
const prazo = (r) => prop(r, P.dataPrazo)?.date?.start?.slice(0, 10) || null;
const criado = (r) => (r.created_time || "").slice(0, 10);
const tiposTarefa = (r) => (prop(r, P.tiposTarefa)?.multi_select || []).map((o) => o.name);
const tipoDemanda = (r) => prop(r, P.tipoDemanda)?.select?.name || null;
const prioridade = (r) => (prop(r, P.prioridade)?.multi_select || []).map((o) => o.name)[0] || null;
const quemTexto = (r) => (prop(r, P.quem)?.rich_text || []).map((t) => t.plain_text).join("").trim();
const relIds = (r, n) => (prop(r, n)?.relation || []).map((x) => x.id);
const responsaveis = (r) => (prop(r, P.responsaveis)?.people || []).map((p) => p.name).filter(Boolean);

const temTipo = (r, lista) => tiposTarefa(r).some((t) => lista.includes(t));
const entregue = (r) => !!finalizado(r);
// ⚠️ Passadas algumas semanas os cards entregues viram "Arquivados". Por isso o que define
// uma entrega é a Data - Finalizado, que fica gravada para sempre, e não o status atual.
const encerrado = (r) => ST_ENCERRADO.has(status(r)) || entregue(r);
const naFila = (r) => ST_FILA.has(status(r)) && !encerrado(r);
const emCriacao = (r) => ST_CRIACAO.has(status(r)) && !encerrado(r);

function topN(map, n = 8) {
  return [...map.entries()]
    .map(([nome, total]) => ({ nome, total }))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome))
    .slice(0, n);
}
const bump = (map, k, v = 1) => map.set(k, (map.get(k) || 0) + v);

// tempo entre a entrada do pedido e a entrega
function tempos(cards) {
  const t = cards.map((r) => diffDays(criado(r), finalizado(r))).filter((d) => d >= 0 && d < 365).sort((a, b) => a - b);
  return {
    media: t.length ? Math.round((t.reduce((s, x) => s + x, 0) / t.length) * 10) / 10 : 0,
    mediana: t.length ? t[Math.floor(t.length / 2)] : 0,
    n: t.length,
  };
}

// ---------- YouTube ----------
const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

async function youtubeFeed() {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL}`);
    if (!r.ok) throw new Error("feed " + r.status);
    const xml = await r.text();
    const canal = unescapeXml((xml.match(/<title>(.*?)<\/title>/) || [])[1] || "Somos A Ponte")
      .replace(/\s*\(.*\)$/, "");
    const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
      titulo: unescapeXml((e.match(/<media:title>([\s\S]*?)<\/media:title>/) || [])[1] || ""),
      data: ((e.match(/<published>(.*?)<\/published>/) || [])[1] || "").slice(0, 10),
      views: +((e.match(/statistics views="(\d+)"/) || [])[1] || 0),
      id: (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1] || "",
    }));
    return { canal, channel_id: YT_CHANNEL, url: `https://www.youtube.com/${YT_HANDLE}`, videos, fonte: "feed" };
  } catch (e) {
    console.warn("  (feed do YouTube falhou: " + e.message + ")");
    return null;
  }
}

async function youtubeApi(base) {
  if (!YT_KEY || !base) return base;
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${YT_CHANNEL}&key=${YT_KEY}`);
    const ch = (await r.json()).items?.[0];
    if (!ch) return base;
    return { ...base, inscritos: +ch.statistics.subscriberCount || 0,
      views_totais: +ch.statistics.viewCount || 0, videos_totais: +ch.statistics.videoCount || 0, fonte: "feed+api" };
  } catch (e) {
    console.warn("  (API do YouTube falhou: " + e.message + ")");
    return base;
  }
}

// recorte do YouTube num intervalo, com os destaques acima da média
function ytPeriodo(yt, de, ate) {
  if (!yt) return null;
  const vids = yt.videos.filter((v) => v.data >= de && v.data <= ate);
  if (!vids.length) return { videos: 0, views: 0, destaques: [], cobre_periodo: yt.videos.at(-1)?.data <= de };
  const views = vids.reduce((s, v) => s + v.views, 0);
  const media = views / vids.length;
  return {
    videos: vids.length,
    views,
    media_views: Math.round(media),
    destaques: vids.filter((v) => v.views > media).sort((a, b) => b.views - a.views).slice(0, 3),
    cobre_periodo: (yt.videos.at(-1)?.data || "9999") <= de,
  };
}

// ---------- build ----------
async function build() {
  await mkdir(DATA, { recursive: true });
  await mkdir(SNAPS, { recursive: true });
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
  const yt = await youtubeApi(await youtubeFeed());
  if (yt) console.log(`  ${yt.videos.length} vídeos no feed${yt.inscritos ? ` · ${yt.inscritos} inscritos` : ""}`);

  let instagram = null;
  try { instagram = JSON.parse(await readFile(join(SOCIAL, "instagram.json"), "utf8")); }
  catch { console.warn("  (sem social/instagram.json)"); }

  const hoje = iso(new Date());
  const mesVigente = hoje.slice(0, 7);

  // ============ ABA 1 — SEMANA VIGENTE (domingo → sábado) ============
  const domingo = addDias(hoje, -diaSemana(hoje));
  const sabado = addDias(domingo, 6);
  const domAnterior = addDias(domingo, -7);
  const sabAnterior = addDias(domingo, -1);

  const noIntervalo = (d, de, ate) => d && d >= de && d <= ate;
  const entreguesSemana = demandas.filter((r) => noIntervalo(finalizado(r), domingo, sabado));
  const entreguesSemAnt = demandas.filter((r) => noIntervalo(finalizado(r), domAnterior, sabAnterior));

  const fila = demandas.filter(naFila);
  const criacao = demandas.filter(emCriacao);
  const emJogo = [...fila, ...criacao];                       // "novo pedido ou in progress"
  const parados = demandas.filter((r) => !encerrado(r) && !naFila(r) && !emCriacao(r));

  const paradosPorStatus = new Map();
  for (const r of parados) bump(paradosPorStatus, status(r));

  const abertas = demandas.filter((r) => !encerrado(r));
  const atrasadas = abertas
    .filter((r) => prazo(r) && prazo(r) < hoje)
    .map((r) => ({
      nome: nome(r) || "(sem nome)", prazo: prazo(r), dias: diffDays(prazo(r), hoje), status: status(r),
      ministerio: relIds(r, P.ministerios).map((id) => mapMinisterio.get(id)).filter(Boolean)[0] || null,
      responsaveis: responsaveis(r),
    }))
    .sort((a, b) => b.dias - a.dias);

  const proximas = abertas
    .filter((r) => prazo(r) && prazo(r) >= hoje && diffDays(hoje, prazo(r)) <= 14)
    .map((r) => ({
      nome: nome(r) || "(sem nome)", prazo: prazo(r), faltam: diffDays(hoje, prazo(r)), status: status(r),
      ministerio: relIds(r, P.ministerios).map((id) => mapMinisterio.get(id)).filter(Boolean)[0] || null,
    }))
    .sort((a, b) => a.faltam - b.faltam)
    .slice(0, 12);

  const semana = {
    inicio: domingo, fim: sabado,
    em_curso: hoje < sabado,
    dias_corridos: diffDays(domingo, hoje) + 1,
    label: `Semana de ${dataBR(domingo)} a ${dataBR(sabado)}`,
    mes_vigente: mesLabel(mesVigente),
    fila: fila.length,
    em_criacao: criacao.length,
    entregues: entreguesSemana.length,
    entregues_semana_anterior: entreguesSemAnt.length,
    fila_videos: emJogo.filter((r) => temTipo(r, T_VIDEO)).length,
    fila_artes: emJogo.filter((r) => temTipo(r, T_ARTES_FILA)).length,
    parados: parados.length,
    parados_por_status: topN(paradosPorStatus, 6),
    atrasadas_total: atrasadas.length,
    atrasadas: atrasadas.slice(0, 12),
    proximas,
    entregues_lista: entreguesSemana.slice(0, 10).map((r) => ({
      nome: nome(r), data: finalizado(r),
      ministerio: relIds(r, P.ministerios).map((id) => mapMinisterio.get(id)).filter(Boolean)[0] || null,
    })).sort((a, b) => a.data.localeCompare(b.data)),
  };

  // ============ ABA 2 — MÊS ANTERIOR ============
  function montaMes(month) {
    const fin = demandas.filter((r) => (finalizado(r) || "").startsWith(month));
    const criadas = demandas.filter((r) => criado(r).startsWith(month));
    const t = tempos(fin);

    // ministérios: cards que passaram pelo mês (entraram ou foram entregues nele)
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

    // campeões de demanda: quem abriu + acompanhamento
    const camp = new Map();
    let comSolicitante = 0;
    for (const r of criadas) {
      const pessoas = new Set();
      const q = quemTexto(r);
      if (q) pessoas.add(normName(q));
      for (const id of relIds(r, P.acompanhamento)) {
        const s = mapSolicitante.get(id);
        if (s) pessoas.add(normName(s));
      }
      if (pessoas.size) comSolicitante++;
      for (const p of pessoas) if (!EXCLUDE.has(p)) bump(camp, p);
    }

    const de = `${month}-01`;
    const ate = `${month}-31`;
    const igMes = instagram?.meses?.[month] || null;
    const perfisIg = igMes
      ? Object.entries(igMes).map(([handle, posts]) => ({ handle, posts })).sort((a, b) => b.posts - a.posts)
      : null;

    return {
      month, label: mesLabel(month), curto: mesCurto(month),
      entregues: fin.length,
      criadas: criadas.length,
      tempo_medio: t.media, tempo_mediana: t.mediana, n_tempo: t.n,
      videos: fin.filter((r) => temTipo(r, T_VIDEO)).length,
      graficos: fin.filter((r) => temTipo(r, T_GRAFICO)).length,
      identidades: fin.filter((r) => temTipo(r, T_IDENTIDADE)).length,
      // Quantas entregas têm "Tipos de Tarefa" preenchido. Sem isso, os números por frente
      // (vídeos / gráficos / identidades) contam só a parte etiquetada do mês.
      classificados: fin.filter((r) => tiposTarefa(r).length).length,
      cobertura_tipos: fin.length ? Math.round((fin.filter((r) => tiposTarefa(r).length).length / fin.length) * 100) : 0,
      campeoes: topN(camp, 6),
      cobertura_campeoes: criadas.length ? Math.round((comSolicitante / criadas.length) * 100) : 0,
      campeoes_preenchidos: comSolicitante,
      ministerios: topN(mins, 8),
      instagram: perfisIg ? {
        total: perfisIg.reduce((s, p) => s + p.posts, 0),
        ativos: perfisIg.filter((p) => p.posts > 0).length,
        perfis: perfisIg,
      } : null,
      youtube: ytPeriodo(yt, de, ate),
    };
  }

  const mesAnt = mesAnterior(mesVigente);
  const aba2 = montaMes(mesAnt);

  // ============ ABA 3 — TRIMESTRE (3 meses anteriores ao vigente) ============
  const mesesTri = [mesAnterior(mesAnterior(mesAnt)), mesAnterior(mesAnt), mesAnt];
  const tri = mesesTri.map(montaMes);
  const triDe = `${mesesTri[0]}-01`;
  const triAte = `${mesAnt}-31`;

  const trimestre = {
    de: mesesTri[0], ate: mesAnt,
    label: `De ${MESES[+mesesTri[0].slice(5, 7) - 1]} a ${MESES[+mesAnt.slice(5, 7) - 1]} de ${mesAnt.slice(0, 4)}`,
    meses: tri,
    total_entregues: tri.reduce((s, m) => s + m.entregues, 0),
    total_videos: tri.reduce((s, m) => s + m.videos, 0),
    total_artes: tri.reduce((s, m) => s + m.graficos + m.identidades, 0),
    tempo_medio: (() => {
      const finTri = demandas.filter((r) => { const f = finalizado(r); return f && f >= triDe && f <= triAte; });
      return tempos(finTri).media;
    })(),
    // Aviso automático: se a etiquetagem variou muito entre os meses, a comparação por
    // frente reflete mudança de preenchimento, não só de produção.
    etiquetagem_irregular: (() => {
      const cobs = tri.map((m) => m.cobertura_tipos);
      const vids = tri.map((m) => m.videos);
      const maxV = Math.max(...vids), minV = Math.min(...vids);
      return Math.min(...cobs) < 90 && maxV >= minV * 3 && maxV - minV >= 10;
    })(),
    cobertura_tipos: tri.map((m) => ({ curto: m.curto, pct: m.cobertura_tipos })),
    youtube: ytPeriodo(yt, triDe, triAte),
    instagram: (() => {
      const somas = {};
      let algum = false;
      for (const m of mesesTri) {
        const mm = instagram?.meses?.[m];
        if (!mm) continue;
        algum = true;
        for (const [h, n] of Object.entries(mm)) somas[h] = (somas[h] || 0) + n;
      }
      if (!algum) return null;
      const perfis = Object.entries(somas).map(([handle, posts]) => ({ handle, posts })).sort((a, b) => b.posts - a.posts);
      return { total: perfis.reduce((s, p) => s + p.posts, 0), perfis };
    })(),
  };

  // ---------- o que ainda não dá para preencher, e por quê ----------
  const faltando = [];
  if (!instagram?.metricas) {
    faltando.push({
      onde: "Instagram — engajamento, alcance, seguidores, salvamentos, desempenho por formato",
      porque: "Esses números só saem pela Graph API da Meta, que exige conta Business ou Creator ligada a uma página do Facebook e um app no Meta for Developers. A contagem de publicações é preenchida à mão em social/instagram.json.",
    });
  }
  if (!yt?.inscritos) {
    faltando.push({
      onde: "YouTube — total de inscritos e ritmo de crescimento",
      porque: "Basta gerar uma chave gratuita da YouTube Data API v3 e colocar em YT_API_KEY no .env.",
    });
  }
  faltando.push({
    onde: "YouTube — tempo de exibição, horários de pico, CTR e interações",
    porque: "São métricas da YouTube Analytics API, que exige autorização OAuth do dono do canal. O feed público entrega só publicações e visualizações.",
  });

  const out = {
    gerado_em: new Date().toISOString(),
    hoje,
    mes_vigente: mesVigente,
    total_demandas: demandas.length,
    semana,
    mes_anterior: aba2,
    trimestre,
    social: { instagram_perfis: instagram?.perfis || [], youtube: yt ? { canal: yt.canal, url: yt.url, inscritos: yt.inscritos || null } : null },
    faltando,
  };

  await writeFile(join(DATA, "painel.json"), JSON.stringify(out, null, 2));
  console.log(`✓ data/painel.json gravado`);

  // ---------- snapshot do dia ----------
  const snap = {
    data: hoje, fila: semana.fila, em_criacao: semana.em_criacao,
    entregues_semana: semana.entregues, atrasadas: semana.atrasadas_total, total_demandas: demandas.length,
  };
  await writeFile(join(SNAPS, `${hoje}.json`), JSON.stringify(snap, null, 2));

  const arquivos = (await readdir(SNAPS)).filter((f) => f.endsWith(".json") && f < `${hoje}.json`).sort();
  if (arquivos.length) {
    const ant = JSON.parse(await readFile(join(SNAPS, arquivos.at(-1)), "utf8"));
    const d = (k) => { const v = snap[k] - ant[k]; return `${v >= 0 ? "+" : ""}${v}`; };
    console.log(`\n— desde ${ant.data} — fila ${d("fila")} · em criação ${d("em_criacao")} · entregues na semana ${d("entregues_semana")} · atrasadas ${d("atrasadas")}`);
  }

  console.log(`\nSemana (${dataBR(domingo)} a ${dataBR(sabado)}):`);
  console.log(`  fila ${semana.fila} · em criação ${semana.em_criacao} · entregues ${semana.entregues} (semana passada: ${semana.entregues_semana_anterior})`);
  console.log(`  fila de vídeos ${semana.fila_videos} · fila de artes ${semana.fila_artes} · atrasadas ${semana.atrasadas_total}`);
  console.log(`${aba2.label}: ${aba2.entregues} entregues · média ${aba2.tempo_medio} dias · ${aba2.videos} vídeos · ${aba2.graficos} gráficos · ${aba2.identidades} identidades`);
  console.log(`Trimestre ${trimestre.label}: ${trimestre.total_entregues} entregues`);
}

build().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
