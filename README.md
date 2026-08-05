# Painel StaffCom · Somos A Ponte

Dashboard das demandas e do trabalho da equipe de comunicação da Ponte Recife, feito para os
gestores lerem no celular. Segue a estrutura do documento **Dashboard StaffCom**: três abas —
semana, mês anterior, trimestre.

Lê os três bancos do Notion (alimentados pelo F.O.C.O.) e o canal do YouTube, e gera um arquivo
HTML único que dá para mandar no WhatsApp ou publicar num link fixo.

## Uso no dia a dia

```bash
node sync.mjs && node build.mjs
```

Ou dois cliques em **`Atualizar painel.command`**.

| Arquivo gerado | Para que serve |
|---|---|
| `Painel.html` | abre com dois cliques, funciona offline, dá pra mandar por WhatsApp/e-mail |
| `publicar/index.html` | arraste a pasta `publicar/` no Netlify → link fixo (ver `PUBLICAR.md`) |

Nenhum dos dois contém token: só os números já calculados.

## O que cada aba mostra

**Aba 1 · Semana** (domingo a sábado, a que abre)
Demandas na fila · em criação · entregues na semana com comparativo da semana anterior ·
fila de vídeos · fila de artes · o que passou do prazo · próximos 14 dias · o que está parado.

**Aba 2 · Mês anterior**
Entregues no mês · média de entrega · campeões de demanda · ranking de ministérios ·
vídeos e reels · materiais gráficos · identidades visuais · análise de Instagram e YouTube
com os destaques que passaram da média.

**Aba 3 · Trimestre** (os três meses fechados antes do vigente)
Comparativo de entregas, tempo de entrega, vídeos e artes mês a mês · visão geral das redes.

## De onde vêm os dados

**Notion** (API oficial, token no `.env`):

| Banco | ID | O que alimenta |
|---|---|---|
| Banco de Dados de Comunicação | `33eda07d…75ea5a` | tudo que é demanda, prazo, status, tipo |
| Acompanhamento de Pedidos | `376da07d…a26f70` | campeões de demanda |
| Ranking Ministérios | `349da07d…424448` | ranking de ministérios |

**YouTube**: feed oficial do canal — não precisa de chave e traz os 15 vídeos mais recentes com
visualizações. `YT_API_KEY` no `.env` acrescenta o número de inscritos.

**Instagram**: contagem manual em `social/instagram.json`, um bloco por mês.

## O que ainda não dá para preencher

O painel mostra isso na própria tela, para ninguém achar que o dado sumiu:

- **Instagram — engajamento, alcance, seguidores, salvamentos, desempenho por formato.**
  Só saem pela Graph API da Meta: exige conta Business ou Creator ligada a uma página do
  Facebook e um app no Meta for Developers.
- **YouTube — inscritos.** Resolve com uma chave gratuita da YouTube Data API v3 em `YT_API_KEY`.
- **YouTube — tempo de exibição, horários de pico, CTR, interações.** São da YouTube Analytics
  API, que exige autorização OAuth do dono do canal.

## Duas decisões que valem saber

**Uma demanda conta como entregue pela `Data - Finalizado`, não pelo status.**
Os cards entregues viram `Arquivados` depois de algumas semanas — 174 dos 343 já estão assim.
Contar por `Status = Finalizado` fazia maio e junho aparecerem com zero entregas. A data fica
gravada para sempre, então o histórico não muda quando alguém arquiva um card.

**"Novo pedido" e "in progress" do documento viraram grupos de status reais:**
fila = `Novo pedido`; em criação = `Começou`, `Em ajuste`, `Em aprovação`,
`Para postar/produzir/avisar`. `Stand by`, `Calendário` e `Avisos` não são nem uma coisa nem
outra, então aparecem à parte como "fora da fila de produção" em vez de sumirem da conta.

O tempo de entrega é medido da criação do card até a data de finalização. O Notion não expõe
por API quando o card entrou em "novo pedido", então a criação é a melhor âncora disponível.

## Estrutura

```
painel/
├── sync.mjs                 lê Notion + YouTube → data/painel.json
├── build.mjs                data/painel.json + template.html → Painel.html
├── template.html            o dashboard (HTML/CSS/JS, sem dependências)
├── assets/                  fonte Archivo embutida no HTML final
├── PUBLICAR.md              como colocar no ar com link fixo
├── ROTINA.md                o que a atualização automática faz
├── .env                     NOTION_TOKEN e IDs  ⚠️ nunca publicar
├── data/
│   ├── painel.json          tudo que o painel mostra
│   └── snapshots/           uma foto por dia, para comparar com ontem
├── social/instagram.json    contagem manual de publicações por mês
└── publicar/index.html      versão para o Netlify
```

## Quando quebrar

Quase sempre é propriedade renomeada no Notion. Os nomes esperados estão no topo do `sync.mjs`,
no objeto `P`. Já aconteceu de `Status do Projeto` ter uma crase no fim do nome e depois perder.
