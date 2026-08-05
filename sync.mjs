#!/usr/bin/env node
/**
 * sync.mjs — coleta diária do Painel de Comunicação · Somos A Ponte
 *
 * Lê os TRÊS bancos do Notion:
 *   1. Banco de Dados de Comunicação  (demandas)
 *   2. Acompanhamento de Pedidos      (solicitantes)
 *   3. Ranking Ministérios            (ministérios)
 * + YouTube Data API (opcional, se YT_API_KEY estiver no .env)
 * + social/instagram.json (snapshot manual — o Instagram não tem API aberta)
 *
 * Grava:
 *   data/painel.json            — tudo que o dashboard precisa
 *   data/snapshots/<data>.json  — foto do dia (permite comparar com ontem)
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

// ⚠️ O banco é vivo: passadas algumas semanas os cards entregues viram "Arquivados".
// Por isso o histórico NÃO pode depender do status — quem manda é a "Data - Finalizado",
// que fica gravada para sempre. (Filtrar por status=Finalizado zerava maio e junho.)
const STATUS_ENCERRADOS = new Set(["Finalizado", "Arquivados"]);
const entregue = (r) => !!prop(r, P.dataFinalizado)?.date?.start;
const encerrado = (r) => STATUS_ENCERRADOS.has(status(r)) || entregue(r);

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

// ---------- leitores de propriedade ----------
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

const diffDays = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
const hojeISO = () => new Date().toISOString().slice(0, 10);

// conta ocorrências e devolve top N ordenado
function topN(map, n = 8) {
  return [...map.entries()]
    .map(([nome, total]) => ({ nome, total }))
    .sort((a, b) => b.total - a.total || a.nome.localeCompare(b.nome))
    .slice(0, n);
}
const bump = (map, k, v = 1) => map.set(k, (map.get(k) || 0) + v);

// ---------- YouTube ----------
// O feed oficial (RSS) não precisa de chave e já traz os 15 últimos vídeos COM views.
// A chave da API é só um extra: acrescenta inscritos e totais do canal.
const YT_CHANNEL = process.env.YT_CHANNEL_ID || "UCLdXFhRIfnF54fpR-iN7lrg";
const unescapeXml = (s) =>
  s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'");

async function youtubeFeed() {
  try {
    const r = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${YT_CHANNEL}`);
    if (!r.ok) throw new Error("feed " + r.status);
    const xml = await r.text();
    const canal = unescapeXml((xml.match(/<title>(.*?)<\/title>/) || [])[1] || "Somos A Ponte");
    const videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
      titulo: unescapeXml((e.match(/<media:title>([\s\S]*?)<\/media:title>/) || [])[1] || ""),
      data: ((e.match(/<published>(.*?)<\/published>/) || [])[1] || "").slice(0, 10),
      views: +((e.match(/statistics views="(\d+)"/) || [])[1] || 0),
      id: (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1] || "",
    }));
    const porMes = {};
    for (const v of videos) {
      const m = v.data.slice(0, 7);
      porMes[m] ??= { videos: 0, views: 0 };
      porMes[m].videos++;
      porMes[m].views += v.views;
    }
    return { canal, channel_id: YT_CHANNEL, url: `https://www.youtube.com/${YT_HANDLE}`, videos, por_mes: porMes, fonte: "feed" };
  } catch (e) {
    console.warn("  (feed do YouTube falhou: " + e.message + ")");
    return null;
  }
}

async function youtubeApi(base) {
  if (!YT_KEY) return base;
  try {
    const r = await fetch(`https://www.googleapis.com/youtube/v3/channels?part=snippet,statistics&id=${YT_CHANNEL}&key=${YT_KEY}`);
    const ch = (await r.json()).items?.[0];
    if (!ch) return base;
    return {
      ...(base || {}),
      canal: ch.snippet.title,
      inscritos: +ch.statistics.subscriberCount || 0,
      views_totais: +ch.statistics.viewCount || 0,
      videos_totais: +ch.statistics.videoCount || 0,
      fonte: "feed+api",
    };
  } catch (e) {
    console.warn("  (API do YouTube falhou: " + e.message + ")");
    return base;
  }
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
  const solicitantesRows = await queryAll(DB_SOLICITANTES);
  const mapSolicitante = new Map(solicitantesRows.map((r) => [r.id, titleOf(r)]));
  console.log(`  ${solicitantesRows.length} solicitantes`);

  console.log("→ Ranking Ministérios…");
  const ministeriosRows = await queryAll(DB_MINISTERIOS);
  const mapMinisterio = new Map(ministeriosRows.map((r) => [r.id, titleOf(r)]));
  console.log(`  ${ministeriosRows.length} ministérios`);

  const hoje = hojeISO();
  const mesAtual = hoje.slice(0, 7);

  // ---- agrupa por mês ----
  const mesesSet = new Set();
  for (const r of demandas) {
    const f = finalizado(r);
    if (f) mesesSet.add(f.slice(0, 7));
    const c = criado(r);
    if (c) mesesSet.add(c.slice(0, 7));
  }
  const mesesOrdenados = [...mesesSet].filter((m) => m <= mesAtual).sort().reverse().slice(0, 14);

  const meses = mesesOrdenados.map((month) => {
    const fin = demandas.filter((r) => (finalizado(r) || "").startsWith(month));
    const criadas = demandas.filter((r) => criado(r).startsWith(month));

    // tempo criação → entrega, de tudo que foi entregue no mês
    const tempos = fin
      .map((r) => diffDays(criado(r), finalizado(r)))
      .filter((d) => d >= 0 && d < 365)
      .sort((a, b) => a - b);
    const media = tempos.length ? tempos.reduce((s, x) => s + x, 0) / tempos.length : 0;
    const mediana = tempos.length ? tempos[Math.floor(tempos.length / 2)] : 0;

    // mesma conta restrita ao ciclo dentro do mês (definição usada nos relatórios de jun/jul)
    const temposMesmoMes = fin
      .filter((r) => criado(r).startsWith(month))
      .map((r) => diffDays(criado(r), finalizado(r)))
      .filter((d) => d >= 0);
    const mediaMesmoMes = temposMesmoMes.length
      ? temposMesmoMes.reduce((s, x) => s + x, 0) / temposMesmoMes.length
      : 0;

    // categorias por tipo de tarefa (sobre o que foi entregue)
    const has = (r, ...ts) => tiposTarefa(r).some((t) => ts.includes(t));
    const categorias = {
      audiovisual: fin.filter((r) => has(r, "Reels", "Edição", "Gravação", "Animação", "Roteiro", "Thumb") || tipoDemanda(r) === "Audiovisual").length,
      social: fin.filter((r) => has(r, "Post Estático", "Carrossel", "Story", "Postar", "Pack Social Media") || tipoDemanda(r) === "Social Media").length,
      identidade: fin.filter((r) => has(r, "Identidade visual", "Pack de Evento")).length,
      impressos: fin.filter((r) => has(r, "Cartaz", "Banner", "Folder", "Panfleto", "Adesivo", "Totem", "Produtos", "Vestimenta", "Sinalização", "Book") || tipoDemanda(r) === "Impressos e Produtos").length,
    };

    // tipos de demanda (fatia do mês)
    const tipos = new Map();
    for (const r of fin) bump(tipos, tipoDemanda(r) || "Sem tipo");

    // ministérios e solicitantes (sobre o que ENTROU no mês — é a demanda real)
    const mins = new Map();
    const sols = new Map();
    const resps = new Map();
    let comSolicitante = 0;
    for (const r of criadas) {
      for (const id of relIds(r, P.ministerios)) {
        const m = mapMinisterio.get(id);
        if (m) bump(mins, m);
      }
      const pessoas = new Set();
      const q = quemTexto(r);
      if (q) pessoas.add(normName(q));
      for (const id of relIds(r, P.acompanhamento)) {
        const s = mapSolicitante.get(id);
        if (s) pessoas.add(normName(s));
      }
      if (pessoas.size) comSolicitante++;
      for (const p of pessoas) if (!EXCLUDE.has(p)) bump(sols, p);
    }
    for (const r of fin) for (const p of responsaveis(r)) bump(resps, p);

    return {
      month,
      label: mesLabel(month),
      curto: mesCurto(month),
      parcial: month === mesAtual,
      finalizadas: fin.length,
      criadas: criadas.length,
      tempo_medio: Math.round(media * 10) / 10,
      tempo_mediana: mediana,
      tempo_medio_ciclo_mes: Math.round(mediaMesmoMes * 10) / 10,
      n_tempo: tempos.length,
      categorias,
      tipos: topN(tipos, 8),
      ministerios: topN(mins, 8),
      solicitantes: topN(sols, 8),
      responsaveis: topN(resps, 8),
      cobertura_solicitante: criadas.length ? Math.round((comSolicitante / criadas.length) * 100) : 0,
      solicitantes_preenchidos: comSolicitante,
    };
  });

  // Só entram no histórico os meses em que a "Data - Finalizado" já era usada —
  // antes disso o zero significa "sem registro", não "sem entrega".
  const historico = meses.filter((m) => m.finalizadas > 0 || m.month === mesAtual);

  // ---- foto de agora (pipeline vivo) ----
  const abertas = demandas.filter((r) => !encerrado(r));
  const pipeline = new Map();
  for (const r of abertas) bump(pipeline, status(r));

  const atrasadas = abertas
    .filter((r) => prazo(r) && prazo(r) < hoje)
    .map((r) => ({
      nome: nome(r) || "(sem nome)",
      prazo: prazo(r),
      dias: diffDays(prazo(r), hoje),
      status: status(r),
      prioridade: prioridade(r),
      ministerio: relIds(r, P.ministerios).map((id) => mapMinisterio.get(id)).filter(Boolean)[0] || null,
      responsaveis: responsaveis(r),
    }))
    .sort((a, b) => b.dias - a.dias);

  const proximas = abertas
    .filter((r) => prazo(r) && prazo(r) >= hoje && diffDays(hoje, prazo(r)) <= 14)
    .map((r) => ({
      nome: nome(r) || "(sem nome)",
      prazo: prazo(r),
      faltam: diffDays(hoje, prazo(r)),
      status: status(r),
      prioridade: prioridade(r),
      ministerio: relIds(r, P.ministerios).map((id) => mapMinisterio.get(id)).filter(Boolean)[0] || null,
    }))
    .sort((a, b) => a.faltam - b.faltam)
    .slice(0, 12);

  // janela rolante de 30 dias — o número que faz sentido numa leitura diária
  const d30 = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const fin30 = demandas.filter((r) => finalizado(r) && finalizado(r) >= d30 && finalizado(r) <= hoje);
  const cri30 = demandas.filter((r) => criado(r) >= d30);
  const t30 = fin30.map((r) => diffDays(criado(r), finalizado(r))).filter((d) => d >= 0 && d < 365);

  // ranking de ministérios do ano corrente
  const ano = hoje.slice(0, 4);
  const minsAno = new Map();
  for (const r of demandas) {
    if (!criado(r).startsWith(ano)) continue;
    for (const id of relIds(r, P.ministerios)) {
      const m = mapMinisterio.get(id);
      if (m) bump(minsAno, m);
    }
  }

  const agora = {
    em_aberto: abertas.length,
    pipeline: topN(pipeline, 12),
    atrasadas_total: atrasadas.length,
    atrasadas: atrasadas.slice(0, 12),
    proximas,
    alta_prioridade: abertas.filter((r) => prioridade(r) === "Alta Prioridade").length,
    sem_prazo: abertas.filter((r) => !prazo(r)).length,
    ultimos30: {
      finalizadas: fin30.length,
      criadas: cri30.length,
      tempo_medio: t30.length ? Math.round((t30.reduce((s, x) => s + x, 0) / t30.length) * 10) / 10 : 0,
    },
  };

  // ---- social ----
  let instagram = null;
  try {
    instagram = JSON.parse(await readFile(join(SOCIAL, "instagram.json"), "utf8"));
    // injeta o snapshot de cada mês na respectiva fatia do painel
    for (const m of historico) {
      const porPerfil = instagram.meses?.[m.month];
      if (!porPerfil) continue;
      const perfis = Object.entries(porPerfil)
        .map(([handle, posts]) => ({ handle, posts }))
        .sort((a, b) => b.posts - a.posts);
      m.instagram = {
        total: perfis.reduce((s, p) => s + p.posts, 0),
        ativos: perfis.filter((p) => p.posts > 0).length,
        perfis,
      };
    }
  } catch {
    console.warn("  (sem social/instagram.json — seção do Instagram fica vazia)");
  }
  console.log("→ YouTube…");
  const yt = await youtubeApi(await youtubeFeed());
  if (yt) {
    console.log(`  ${yt.videos.length} vídeos no feed${yt.inscritos ? ` · ${yt.inscritos} inscritos` : " (sem YT_API_KEY: não traz inscritos)"}`);
    // injeta o mês correspondente em cada fatia do painel
    for (const m of historico) {
      const y = yt.por_mes[m.month];
      if (y) m.youtube = { ...y, novos: yt.videos.filter((v) => v.data.startsWith(m.month)).slice(0, 5) };
    }
  }

  const out = {
    gerado_em: new Date().toISOString(),
    hoje,
    mes_atual: mesAtual,
    total_demandas: demandas.length,
    meses: historico,
    agora,
    ministerios_ano: topN(minsAno, 10),
    ministerios_cadastrados: ministeriosRows.length,
    solicitantes_cadastrados: solicitantesRows.length,
    social: { instagram, youtube: yt },
  };

  await writeFile(join(DATA, "painel.json"), JSON.stringify(out, null, 2));
  console.log(`✓ data/painel.json (${demandas.length} demandas, ${meses.length} meses)`);

  // ---- snapshot do dia: permite comparar com ontem ----
  const snap = {
    data: hoje,
    em_aberto: agora.em_aberto,
    atrasadas: agora.atrasadas_total,
    alta_prioridade: agora.alta_prioridade,
    finalizadas_mes: historico[0]?.finalizadas ?? 0,
    criadas_mes: historico[0]?.criadas ?? 0,
    finalizadas_30d: agora.ultimos30.finalizadas,
    total_demandas: demandas.length,
  };
  await writeFile(join(SNAPS, `${hoje}.json`), JSON.stringify(snap, null, 2));

  // diff com o snapshot anterior
  const arquivos = (await readdir(SNAPS)).filter((f) => f.endsWith(".json") && f < `${hoje}.json`).sort();
  const anterior = arquivos.length ? JSON.parse(await readFile(join(SNAPS, arquivos.at(-1)), "utf8")) : null;
  if (anterior) {
    const d = (k) => snap[k] - anterior[k];
    console.log(`\n— comparado com ${anterior.data} —`);
    console.log(`  em aberto      ${snap.em_aberto}  (${d("em_aberto") >= 0 ? "+" : ""}${d("em_aberto")})`);
    console.log(`  atrasadas      ${snap.atrasadas}  (${d("atrasadas") >= 0 ? "+" : ""}${d("atrasadas")})`);
    console.log(`  entregues/mês  ${snap.finalizadas_mes}  (${d("finalizadas_mes") >= 0 ? "+" : ""}${d("finalizadas_mes")})`);
    console.log(`  novas/mês      ${snap.criadas_mes}  (${d("criadas_mes") >= 0 ? "+" : ""}${d("criadas_mes")})`);
  }

  console.log(`\nResumo de hoje (${hoje}):`);
  console.log(`  ${agora.em_aberto} em aberto · ${agora.atrasadas_total} atrasadas · ${agora.alta_prioridade} de alta prioridade`);
  console.log(`  ${agora.ultimos30.finalizadas} entregues nos últimos 30 dias (média ${agora.ultimos30.tempo_medio} dias)`);
}

build().catch((e) => {
  console.error("✗ " + e.message);
  process.exit(1);
});
