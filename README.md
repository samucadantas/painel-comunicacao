# Painel de Comunicação · Somos A Ponte

Dashboard do trabalho da comunicação, feito para gestores lerem no celular em 30 segundos.
Lê os três bancos do Notion + o canal do YouTube, e vira um arquivo HTML só que dá pra
mandar no WhatsApp ou publicar num link fixo.

## Uso no dia a dia

```bash
node sync.mjs && node build.mjs
```

Ou dois cliques em **`Atualizar painel.command`**.

Isso gera:

| Arquivo | Para que serve |
|---|---|
| `Painel.html` | abre com dois cliques, funciona offline, dá pra mandar por WhatsApp/e-mail |
| `publicar/index.html` | arraste a pasta `publicar/` no Netlify → link fixo para os gestores |

Nenhum dos dois contém token: só os números já calculados.

## De onde vêm os dados

**Notion** (via API oficial, token no `.env`):

| Banco | ID | O que entra no painel |
|---|---|---|
| Banco de Dados de Comunicação | `33eda07d…75ea5a` | entregas, prazos, tipos, status, responsáveis |
| Acompanhamento de Pedidos | `376da07d…a26f70` | nome de quem pediu (ranking de solicitantes) |
| Ranking Ministérios | `349da07d…424448` | qual ministério demandou (ranking de ministérios) |

**YouTube**: feed oficial do canal (`youtube.com/feeds/videos.xml`) — não precisa de chave e já
traz os 15 vídeos mais recentes com visualizações. Preencher `YT_API_KEY` no `.env` acrescenta o
número de inscritos.

**Instagram**: contagem manual em `social/instagram.json`, um bloco por mês. O Instagram não tem
API aberta — só a Graph API da Meta, que exige conta Business ligada a uma página do Facebook.

## Detalhe importante: como uma demanda conta como entregue

Vale a **`Data - Finalizado`** do card, não o status.

Os cards entregues viram `Arquivados` depois de algumas semanas — 174 dos 343 já estão assim.
Contar por `Status = Finalizado` fazia maio e junho aparecerem com zero entregas. A data fica
gravada para sempre, então o histórico não muda mais quando alguém arquiva um card.

## Estrutura

```
painel/
├── sync.mjs                 lê Notion + YouTube → data/painel.json
├── build.mjs                data/painel.json + template.html → Painel.html
├── template.html            o dashboard (HTML/CSS/JS, sem dependências)
├── ROTINA.md                o que a checagem diária faz
├── .env                     NOTION_TOKEN e IDs  ⚠️ nunca publicar
├── data/
│   ├── painel.json          tudo que o painel mostra
│   └── snapshots/           uma foto por dia, para comparar com ontem
├── social/instagram.json    contagem manual de posts por mês
└── publicar/index.html      versão para o Netlify
```

## Quando quebrar

Se o `sync.mjs` acusar erro ou vier com números estranhos, quase sempre é propriedade renomeada
no Notion. Os nomes esperados estão no topo do `sync.mjs`, no objeto `P`. Já aconteceu de
`Status do Projeto` ter uma crase no fim do nome e depois perder.
