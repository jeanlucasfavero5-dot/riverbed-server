# Riverbed Warfare — servidor

Servidor em **Node.js 18+ sem dependências** (nada para instalar). Ele guarda as contas e serve o jogo.

## O que o servidor faz
- **Contas**: nick único no mundo todo (sem diferenciar maiúsculas/minúsculas), nicks reservados, ID de 9 dígitos sequencial, senha com `scrypt`, sessões por token (30 dias), limite de tentativas e bloqueio por erros de senha.
- **Caixa de mensagens**: suporte, avisos de clã, compras, validade de cartões e conquistas, com **prêmios resgatáveis** (boas-vindas 50 💎, missão cumprida 5 💎).
- **Diamantes e cupons**: `DIAMANTETESTE` (+99 💎, 1 vez por conta, temporário) e cupons de influenciador (+50 💎 ao jogador, +5 💎 ao influenciador, mesmo que ele ainda não tenha conta).
- **Cartões do Mercado** (24 h, 20 💎): coleta, dano e velocidade (+10%).
- **Clãs**: nome, tag de 3 letras, logo, pedidos de entrada, até 3 vice-líderes, banir, passar liderança, dissolução em 3 dias (dá para restabelecer), líder 30 dias inativo passa ao vice mais antigo, 1 aviso por dia.
- **Conquistas, ranking mensal e medalhas** (ouro/prata/bronze na virada do mês) e selo de **verificado** (`isInfluencer`).
- **Painel admin** por `curl` (veja abaixo) e **arquivo único de dados** (`data/db.json`, gravação atômica).

## Rodar no seu computador
```bash
node server.js            # abre em http://localhost:3000
npm test                  # 54 verificações automáticas da API
```
Abra `http://localhost:3000`: o jogo detecta o servidor sozinho (aparece "🟢 Servidor conectado" na tela de login). Se abrir o `index.html` direto do disco, ele funciona em modo local; para usar um servidor remoto, abra com `?api=https://seu-servidor`.

## Publicar na internet
Use qualquer hospedagem que rode Node ou Docker (Render, Railway, Fly.io, VPS). Pontos importantes:
1. **HTTPS é obrigatório** em produção (senhas e tokens trafegam no corpo e no cabeçalho). Hospedagens como Render/Railway já dão HTTPS.
2. Monte um **disco persistente** e aponte `DATA_DIR` para ele (no Docker: volume em `/data`). Sem isso, as contas somem a cada deploy.
3. Atrás de proxy (Render/Railway/Nginx), defina `TRUST_PROXY=1` para o limite de tentativas enxergar o IP real.
4. Faça **backup** copiando `db.json` periodicamente.

| Variável | Para que serve |
|---|---|
| `PORT` | porta (padrão 3000) |
| `DATA_DIR` | pasta do `db.json` (padrão `./data`) |
| `ADMIN_KEY` | habilita o painel admin (sem ela, fica desativado) |
| `TRUST_PROXY` | `1` atrás de proxy |
| `CORS_ORIGIN` | origem permitida (padrão `*`) |

## Painel admin
```bash
H='X-Admin-Key: SUA_CHAVE'; U=https://seu-servidor
curl -H "$H" -H 'Content-Type: application/json' $U/api/admin/influencer -d '{"nick":"Capudo","coupon":"capudo7"}'   # selo ✔ + cupom
curl -H "$H" -H 'Content-Type: application/json' $U/api/admin/msg -d '{"to":"all","title":"Aviso","body":"Manutenção às 3h","claim":10}'
curl -H "$H" -H 'Content-Type: application/json' $U/api/admin/grant -d '{"nick":"Jogador1","dia":100}'   # confirmação de recarga
curl -H "$H" $U/api/admin/stats
```
Regras fixas ficam no topo do `server.js`: `PROMOS` (cupons de teste), `INFL` (cupom → nick do influenciador), `CARDS`, `ACH` (conquistas) e limites.

## Limites e segurança (leia)
- O **modo offline roda no navegador**. Por isso o servidor **não vê** as partidas: ele apenas recebe o progresso (abates, construções, vitórias) e **limita** quanto cada envio pode somar; a recompensa por base inimiga tem teto diário (10 por dia). Quem editar o código do navegador consegue, no máximo, chegar a esses tetos.
- Tudo que vale diamante é decidido no servidor: boas-vindas, missões, cupons, cartões, créditos de influenciador.
- Ainda **não há partida online em tempo real**: o botão "Modo Online" continua "em breve". Ela precisa de um servidor de partida (WebSocket) que simule o jogo, e é o próximo passo.
- Recarga com dinheiro real **não está implementada**: o admin pode creditar diamantes (`/api/admin/grant`), o que gera a mensagem de confirmação.
