# Colocar o painel no ar (link fixo, atualizado sozinho todo dia)

O repositório local já está pronto e commitado — **sem o token**, que fica só no seu Mac.
Faltam quatro passos, todos rápidos.

## 1. Criar o repositório no GitHub

Em https://github.com/new:

- Nome: `painel-comunicacao`
- **Private** ← importante: o painel tem nomes de pessoas e demandas internas
- Não marque "Add a README" (o repositório local já tem o seu)

## 2. Subir o que já está pronto

Na pasta `painel/`:

```bash
git remote add origin https://github.com/SEU-USUARIO/painel-comunicacao.git && git push -u origin main
```

## 3. Cadastrar o token do Notion como segredo

No repositório: **Settings → Secrets and variables → Actions → New repository secret**

Dois segredos, um de cada vez:

- `NOTION_TOKEN` — o token que está no seu `painel/.env`
- `GENNA_API_KEY` — a chave do Genna, também no `.env`

Sem o primeiro a automação roda mas não lê o Notion. Sem o segundo, o painel perde as
métricas de Instagram (alcance, salvamentos, compartilhamentos, top publicações).

A partir daí o GitHub atualiza o painel **todo dia às 8h da manhã** (horário de Recife) sozinho.
Para atualizar na hora, vá em **Actions → Atualizar painel → Run workflow**.

## 4. Gerar o link para os gestores

Use o **Netlify**, que é grátis e funciona com repositório privado:

1. Entre em https://app.netlify.com com a conta do GitHub
2. **Add new site → Import an existing project → GitHub → painel-comunicacao**
3. Nas configurações de build:
   - Build command: deixe **vazio**
   - Publish directory: `publicar`
4. Deploy

Pronto: o Netlify dá um endereço fixo (dá para trocar para algo como
`painel-aponte.netlify.app`) que se atualiza sozinho toda vez que a automação roda.
É esse link que você manda para os gestores — eles abrem no celular, sem senha e sem instalar nada.

> O link não pede senha: quem tiver o endereço vê o painel. Não há dado sensível ali
> (nomes de projetos e de quem pediu, nada de contato ou informação pessoal), mas vale saber
> disso antes de espalhar. Se quiser proteger, o Netlify permite senha no plano pago.

## Enquanto isso não acontece

O `Painel.html` na pasta já funciona: dois cliques em **`Atualizar painel.command`** e ele
busca tudo de novo e abre atualizado. Dá para mandar o arquivo por WhatsApp — ele abre sozinho,
sem internet.
