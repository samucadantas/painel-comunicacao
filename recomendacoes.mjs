/**
 * recomendacoes.mjs — o que o painel sugere fazer, derivado só dos próprios números.
 *
 * Regra desta casa: nenhuma frase genérica de marketing. Cada recomendação nasce de uma
 * comparação feita com os dados da própria Ponte e carrega a base junto, para o gestor
 * poder discordar olhando a conta. Quando a amostra é pequena demais para sustentar a
 * frase, a recomendação não sai — silêncio é melhor que palpite com cara de dado.
 */

const DIAS = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];
const maiuscula = (t) => t.charAt(0).toUpperCase() + t.slice(1);

/**
 * Mediana, não média.
 *
 * Dois reels do @entranatoca fizeram 1,65 milhão de views num trimestre de 1,77 milhão.
 * Pela média, "Reels rende 31,7× mais que imagem" — número verdadeiro e conselho falso:
 * o que aconteceu ali foi um viral, não um padrão de formato. A mediana descreve a
 * publicação típica, que é sobre o que dá para decidir.
 */
const mediana = (xs) => {
  if (!xs.length) return 0;
  const o = [...xs].sort((a, b) => a - b);
  const m = o.length >> 1;
  return o.length % 2 ? o[m] : Math.round((o[m - 1] + o[m]) / 2);
};
const nf = (n) => new Intl.NumberFormat("pt-BR").format(Math.round(n));
const dias = (de, ate) => Math.round((Date.parse(ate) - Date.parse(de)) / 86400000);

/**
 * "Reels rende 4,2× mais que carrossel neste perfil."
 * Só sai com 3+ publicações de cada formato e diferença de pelo menos 50% — abaixo
 * disso é oscilação, não padrão.
 */
function formatoQueRende(perfil) {
  const f = Object.entries(perfil.analise?.formato || {})
    .filter(([, v]) => (v.views || []).length >= 3)
    .map(([nome, v]) => [nome, { n: v.views.length, mediana: mediana(v.views) }]);
  if (f.length < 2) return null;
  f.sort((a, b) => b[1].mediana - a[1].mediana);
  const [melhorNome, melhor] = f[0];
  const [piorNome, pior] = f.at(-1);
  if (!pior.mediana) return null;
  const vezes = melhor.mediana / pior.mediana;
  if (vezes < 1.5) return null;
  return {
    texto: `${melhorNome} rende ${vezes.toFixed(1).replace(".", ",")}× mais views que ${piorNome.toLowerCase()} em ${perfil.handle}.`,
    base: `Mediana de ${nf(melhor.mediana)} views por ${melhorNome.toLowerCase()} (${melhor.n} no trimestre) contra ${nf(pior.mediana)} por ${piorNome.toLowerCase()} (${pior.n}).`,
    perfil: perfil.handle,
  };
}

/**
 * "Quarta e domingo concentram 68% das views."
 * Exige 8+ publicações no trimestre e concentração real (dois dias passando de 50%),
 * senão qualquer distribuição vira "descoberta".
 */
function diasQueConcentram(perfil) {
  // Pela soma de views, um único viral elegia o dia da semana em que ele saiu. A pergunta
  // útil é outra: em que dia as publicações COSTUMAM ir acima do normal do perfil. Então
  // conta-se quantas passaram da mediana, que é imune ao viral.
  const dd = perfil.analise?.dia_semana || [];
  const todas = dd.flatMap((d) => d.views_lista || []);
  if (todas.length < 10) return null;
  const corte = mediana(todas);
  if (!corte) return null;
  const acima = dd.map((d, i) => ({
    i, n: (d.views_lista || []).length,
    bons: (d.views_lista || []).filter((v) => v > corte).length,
  })).filter((d) => d.n >= 2);
  if (acima.length < 3) return null;
  acima.sort((a, b) => b.bons / b.n - a.bons / a.n);
  const melhor = acima[0];
  const taxa = melhor.bons / melhor.n;
  const geral = todas.filter((v) => v > corte).length / todas.length;
  if (taxa < 0.7 || taxa < geral * 1.6) return null;
  return {
    texto: `${maiuscula(DIAS[melhor.i])} é o dia mais consistente de ${perfil.handle}.`,
    base: `${melhor.bons} das ${melhor.n} publicações de ${DIAS[melhor.i]} ficaram acima da mediana do perfil (${nf(corte)} views), contra ${Math.round(geral * 100)}% no geral.`,
    perfil: perfil.handle,
  };
}

/** "@pontezinha não publica há 83 dias." Parado é informação, e ninguém vai atrás dela. */
function perfilParado(perfil, hoje) {
  const u = perfil.analise?.ultima_publicacao;
  if (!u) return null;
  const d = dias(u, hoje);
  if (d < 30) return null;
  return {
    texto: `${perfil.handle} não publica há ${d} dias.`,
    base: `Última publicação em ${u.split("-").reverse().join("/")}.`,
    perfil: perfil.handle,
    alerta: true,
  };
}

/**
 * "Duas publicações valeram mais que as outras 35 juntas."
 * O caso em que a média engana: quando o topo domina, otimizar a média é o conselho errado.
 */
function topoDomina(perfil) {
  const t = perfil.trimestre;
  if (!t || t.publicacoes < 10 || !t.top?.length) return null;
  const doTopo = t.top.slice(0, 2).reduce((s, p) => s + (p.views || 0), 0);
  if (!t.views || doTopo / t.views < 0.5) return null;
  return {
    texto: `Duas publicações responderam por ${Math.round((doTopo / t.views) * 100)}% das views de ${perfil.handle} no trimestre.`,
    base: `${nf(doTopo)} de ${nf(t.views)} views, em ${t.publicacoes} publicações.`,
    perfil: perfil.handle,
  };
}

/** Prazo das demandas: o lado do Notion. */
function prazoDemandas(mes, trimestre) {
  const meses = trimestre?.meses || [];
  if (meses.length < 2) return null;
  const atual = meses.at(-1), antes = meses.at(-2);
  if (atual.media_entrega == null || antes.media_entrega == null) return null;
  const dif = atual.media_entrega - antes.media_entrega;
  if (Math.abs(dif) < 0.5) return null;
  const subiu = dif > 0;
  return {
    texto: subiu
      ? `O tempo médio de entrega subiu ${dif.toFixed(1).replace(".", ",")} dia(s) em ${atual.label}.`
      : `O tempo médio de entrega caiu ${Math.abs(dif).toFixed(1).replace(".", ",")} dia(s) em ${atual.label}.`,
    base: `${atual.media_entrega.toFixed(1).replace(".", ",")} dias contra ${antes.media_entrega.toFixed(1).replace(".", ",")} em ${antes.label}, com ${nf(atual.entregues)} entregas.`,
    alerta: subiu,
  };
}

/**
 * Monta a lista. A ordem é de ação: primeiro o que está errado agora (alertas), depois
 * o que orienta a próxima publicação. Teto de 6 — uma lista que não acaba não é
 * recomendação, é relatório.
 */
export function recomendar({ perfis, mes, trimestre, hoje }) {
  const itens = [];
  for (const p of perfis || []) {
    if (!p || p.erro) continue;
    itens.push(perfilParado(p, hoje));
  }
  itens.push(prazoDemandas(mes, trimestre));
  for (const p of perfis || []) {
    if (!p || p.erro) continue;
    const concentrado = topoDomina(p);
    if (concentrado) {
      // Quando duas publicações respondem por metade do trimestre, qualquer leitura de
      // "padrão" desse perfil está descrevendo o viral. Fica só o fato, sem a conclusão.
      itens.push(concentrado);
      continue;
    }
    // Uma por perfil: seis recomendações de um perfil só não é um painel de sete.
    itens.push(formatoQueRende(p) || diasQueConcentram(p));
  }
  const limpos = itens.filter(Boolean);
  // alertas primeiro, mantendo a ordem de relevância dentro de cada grupo
  return [...limpos.filter((x) => x.alerta), ...limpos.filter((x) => !x.alerta)].slice(0, 6);
}
