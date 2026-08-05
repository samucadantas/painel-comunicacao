# Rotina diária do Painel de Comunicação

Instruções para a checagem automática de todo dia. A rotina agendada aponta para este arquivo —
para mudar o que é feito ou o tom do resumo, basta editar aqui.

## O que fazer

1. Rodar a atualização na pasta `~/Desktop/_ai/A Ponte/Reports Com/painel`:

   ```bash
   node sync.mjs && node build.mjs
   ```

   O `sync.mjs` lê os três bancos do Notion e o feed do YouTube.
   O `build.mjs` regenera `Painel.html` e `publicar/index.html`.

2. Ler `data/painel.json` e comparar com o snapshot de ontem em `data/snapshots/`.

3. Escrever um resumo curto, em português, direto — do jeito que se manda para um gestor no WhatsApp.

## O que olhar (aba 1, a da semana)

- **Entregues na semana** contra a semana anterior, lembrando que a semana corrente
  ainda está correndo.
- **Fila e em criação**: cresceu ou diminuiu desde ontem.
- **Atrasos**: o que passou do prazo, priorizando o que atrasou mais. Se alguma coisa
  virou atraso de ontem para hoje, dizer o nome.
- **Prazos de hoje e amanhã**: nomes, para ninguém ser pego de surpresa.
- **Redes**: se saiu vídeo novo no YouTube. O Instagram é contagem manual: se o mês
  corrente ainda não tem número em `social/instagram.json`, lembrar disso uma vez por semana
  (não todo dia, para não virar ruído).

No começo de cada mês, conferir a aba 2 (mês anterior) e a aba 3 (trimestre), que só
mudam quando o mês vira.

## Regras

- Se nada mudou desde ontem, dizer isso em uma linha. Não inventar movimento.
- Números vêm do `painel.json`, nunca de estimativa.
- Sinalizar quando algo parece erro de preenchimento no Notion e não problema real de operação —
  por exemplo: card antigo em "Stand by" com prazo vencido há meses, ou mês com quase nenhum
  solicitante preenchido.
- Se o `sync.mjs` falhar, dizer o erro e parar. O erro mais provável é uma propriedade
  renomeada no Notion (já aconteceu com `Status do Projeto`).
