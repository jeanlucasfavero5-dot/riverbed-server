#!/usr/bin/env node
/* Riverbed Warfare — servidor (Node.js 18+, sem dependências).
   Guarda contas, sessões, mensagens, diamantes, cupons, cartões, clãs, conquistas e ranking.
   Também serve o jogo (pasta public/) para o cliente falar com a API no mesmo endereço. */
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');

/* ===== configuração (variáveis de ambiente) ===== */
const PORT = process.env.PORT === undefined ? 3000 : +process.env.PORT;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ADMIN_KEY = process.env.ADMIN_KEY || '';           // sem ela, o painel admin fica desativado
const TRUST_PROXY = process.env.TRUST_PROXY === '1';     // use 1 atrás de Render/Railway/Nginx
const PUB = path.join(__dirname, 'public'), FILE = path.join(DATA_DIR, 'db.json');
const DAY = 864e5, now = () => Date.now(), today = () => new Date().toISOString().slice(0, 10);

/* ===== regras do jogo (espelham o cliente) ===== */
const PROMOS = { diamanteteste: 99 };   // cupom TEMPORÁRIO de teste (1 vez por conta): apague para desativar
const INFL = { capudo7: 'capudo' };     // cupom de influenciador → nick (o admin também pode definir)
const RESERVED = ['admin', 'administrador', 'suporte', 'support', 'moderador', 'sistema', 'riverbed', 'gm'];
const CARD_PRICE = 20;
const CARDS = { coleta: ['Coleta de recursos', '+10% de taxa de coleta'], dano: ['Dano das tropas', '+10% de dano'], velocidade: ['Velocidade', '+10% de velocidade de movimento'] };
const EMOJIS = ['⚔️', '🛡️', '🏹', '🐺', '🦅', '🐉', '💀', '🦁', '🔥', '⚓'];
const ACH = [ // id, nome, descrição, modo, condição sobre as estatísticas
  ['m1', 'Primeira Missão', 'Jogue uma partida offline', 'off', s => s.matches >= 1],
  ['k10', 'Caçador de Recrutas', 'Derrote 10 tropas inimigas', 'off', s => s.kills >= 10],
  ['k100', 'Ceifador', 'Derrote 100 tropas inimigas', 'off', s => s.kills >= 100],
  ['b10', 'Construtor', 'Conclua 10 construções', 'off', s => s.built >= 10],
  ['t25', 'Recrutador', 'Treine 25 unidades', 'off', s => s.trained >= 25],
  ['l4', 'Alto Comando', 'Chegue ao nível 4', 'off', s => s.lvl >= 4],
  ['w1', 'Vitória Esmagadora', 'Destrua todas as bases da IA', 'off', s => s.wins >= 1],
  ['bomb', 'Chuva de Fogo', 'Lance 3 bombas', 'off', s => s.bombs >= 3],
  ['tr10', 'Mercador', 'Faça 10 negociações no mercado', 'off', s => s.trades >= 10],
  ['ship', 'Almirante', 'Construa um navio de guerra', 'off', s => s.ships >= 1],
  ['clan', 'Irmandade', 'Entre em um clã', 'off', s => s.clan >= 1],
  ['cup', 'Apoiador', 'Resgate um cupom', 'off', s => s.coupon >= 1],
  ['o1', 'Estreia Online', 'Jogue uma partida online', 'on', s => s.omatches >= 1],
  ['ow5', 'Duelista', 'Vença 5 partidas online', 'on', s => s.owins >= 5],
  ['ow25', 'Lenda do Rio', 'Vença 25 partidas online', 'on', s => s.owins >= 25],
  ['zb5', 'Sobrevivente', 'Chegue à rodada 5 da Invasão Zumbi', 'off', s => s.zround >= 5],
  ['zb10', 'Exterminador de Zumbis', 'Sobreviva até a rodada 10 da Invasão Zumbi', 'off', s => s.zround >= 10],
  ['upg', 'Engenheiro', 'Evolua 5 estruturas', 'off', s => s.upg >= 5]];
/* o progresso do modo offline é informado pelo cliente: o servidor limita o quanto cada envio pode somar */
const DELTA_CAP = { kills: 150, built: 40, trained: 60, bombs: 12, trades: 40, ships: 6, matches: 3, wins: 2, upg: 25, zwin: 1, omatches: 3, owins: 2 };
const MAX_CAP = { lvl: 4, zround: 100 };   // a Invasão Zumbi é infinita
const SCORE_PER_SEND = 600, SCORE_PER_DAY = 4000, BASEKILL_PER_DAY = 10;

/* ===== banco de dados em arquivo JSON (escrita atômica) ===== */
let db = { v: 1, counter: 0, users: {}, nicks: {}, clans: {}, sessions: {}, credits: {}, month: null };
function load() { try { db = Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch (e) { /* primeira execução */ } }
let dirty = false, timer = null;
function writeNow() { if (!dirty) return; dirty = false; fs.mkdirSync(DATA_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, FILE); }
function save() { dirty = true; if (timer) return; timer = setTimeout(() => { timer = null; writeNow(); }, 300); if (timer.unref) timer.unref(); }

/* ===== utilidades ===== */
class HttpErr extends Error { constructor(m, s = 400) { super(m); this.s = s; } }
const E = (m, s) => { throw new HttpErr(m, s); };
const rid = () => crypto.randomBytes(6).toString('hex');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('hex');
const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.floor(+v || 0)));
const hits = new Map();
setInterval(() => hits.clear(), 10 * 60e3).unref();
function limit(req, key, max, win) { // limite de requisições por IP
  if (process.env.RW_TEST === '1') return; // desligado só nos testes automáticos
  const ip = (TRUST_PROXY && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress, k = key + '|' + ip, t = now();
  const a = (hits.get(k) || []).filter(x => t - x < win); a.push(t); hits.set(k, a);
  if (a.length > max) E('Muitas tentativas. Aguarde um pouco.', 429);
}
const fails = new Map(); // bloqueio por conta após erros de senha

/* ===== contas, mensagens, conquistas ===== */
function msg(u, m) {
  u.msgs.unshift({ id: rid(), t: m.t, title: m.title, body: m.body, ts: now(), read: false, claim: m.claim ? { n: m.claim, done: false } : null });
  while (u.msgs.length > 200) { const i = u.msgs.map(x => !(x.claim && !x.claim.done)).lastIndexOf(true); if (i < 0) break; u.msgs.splice(i, 1); }
}
function checkAch(u) {
  const out = [];
  for (const [id, n, d, , f] of ACH) if (!u.ach[id] && f(u.stats)) { u.ach[id] = now(); out.push(n); msg(u, { t: 'conquista', title: 'Missão cumprida: ' + n, body: d + '. Resgate seus 5 💎 de recompensa.', claim: 5 }); }
  return out;
}
function flagInfluencer(u) {
  for (const [c, n] of Object.entries(INFL)) if (n === u.nick.toLowerCase() && !u.couponCode) { u.isInfluencer = true; u.couponCode = c; }
  if (u.couponCode && db.credits[u.couponCode]) { // diamantes de cupons usados antes de o influenciador existir
    const v = 5 * db.credits[u.couponCode]; delete db.credits[u.couponCode]; u.dia += v;
    msg(u, { t: 'sistema', title: 'Créditos de influenciador', body: 'Você recebeu +' + v + ' 💎 de cupons resgatados.' });
  }
}
function newUser(nick, pw) {
  const id = String(++db.counter).padStart(9, '0'), salt = crypto.randomBytes(16).toString('hex');
  const u = { id, nick, salt, hash: hashPw(pw, salt), born: now(), last: now(), dia: 0, cartoesMercado: { coleta: 0, dano: 0, velocidade: 0 }, isInfluencer: false, couponCode: null, medalhaRank: null, score: 0, monthScore: 0, stats: {}, ach: {}, msgs: [], clanId: null, redeemed: null, promo: {}, cardNote: {}, daily: { d: '', base: 0, sc: 0 } };
  db.users[id] = u; db.nicks[nick.toLowerCase()] = id;
  flagInfluencer(u);
  msg(u, { t: 'suporte', title: 'Bem-vindo ao Riverbed Warfare', body: 'Aqui chegam avisos do suporte, confirmações de recarga e compras, validade dos seus cartões e mensagens do seu clã. Seu presente: 50 diamantes!', claim: 50 });
  save(); return u;
}
const pub = u => ({ id: u.id, nick: u.nick, dia: u.dia, cartoesMercado: u.cartoesMercado, isInfluencer: u.isInfluencer === true, couponCode: u.couponCode, medalhaRank: u.medalhaRank, score: u.score, monthScore: u.monthScore, stats: u.stats, ach: u.ach, msgs: u.msgs, clanId: u.clanId, redeemed: u.redeemed, promo: u.promo, born: u.born, last: u.last });
const card = u => ({ id: u.id, nick: u.nick, clanId: u.clanId, medalhaRank: u.medalhaRank, isInfluencer: u.isInfluencer === true, monthScore: u.monthScore });
const ok = (u, extra) => Object.assign({ me: pub(u) }, extra || {});
function checkNick(n) {
  n = String(n || '').trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(n)) return 'O nick deve ter de 3 a 16 caracteres: letras, números ou _.';
  if (RESERVED.includes(n.toLowerCase())) return 'Este nick é reservado.';
  if (db.nicks[n.toLowerCase()]) return 'Este nick já está em uso.';
  return '';
}
function userMaint(u) { // avisa quando um cartão expira
  const t = now();
  for (const k in CARDS) { const e = u.cartoesMercado[k]; if (e && e < t && u.cardNote[k] !== e) { u.cardNote[k] = e; msg(u, { t: 'validade', title: 'Cartão expirado: ' + CARDS[k][0], body: 'O bônus de ' + CARDS[k][1] + ' acabou. Compre outro no Perfil ou no Mercado.' }); save(); } }
}

/* ===== clãs ===== */
const role = (c, id) => c.leader === id ? 'lider' : c.vices.some(v => v.id === id) ? 'vice' : c.members.some(m => m.id === id) ? 'membro' : null;
const toAll = (c, title, body) => c.members.forEach(m => { const a = db.users[m.id]; if (a) msg(a, { t: 'clã', title, body }); });
const myClan = u => (u.clanId && db.clans[u.clanId]) || null;
const staffOf = (u) => { const c = myClan(u); return c && role(c, u.id) !== 'membro' ? c : null; };
function cleanLogo(l) {
  const hsl = /^hsl\(\d{1,3},\d{1,3}%,\d{1,3}%\)$/;
  l = l || {}; return { e: EMOJIS.includes(l.e) ? l.e : EMOJIS[0], a: hsl.test(l.a) ? l.a : 'hsl(120,60%,34%)', b: hsl.test(l.b) ? l.b : 'hsl(150,70%,16%)' };
}

/* ===== manutenção global: ranking mensal, dissolução de clãs, líder inativo ===== */
let lastMaint = 0;
function maintGlobal(force) {
  const t = now(); if (!force && t - lastMaint < 30000) return; lastMaint = t;
  const ym = new Date().toISOString().slice(0, 7);
  if (db.month !== ym) {
    if (db.month) {
      const us = Object.values(db.users), top = us.filter(x => x.monthScore > 0).sort((a, b) => b.monthScore - a.monthScore).slice(0, 3), M = ['ouro', 'prata', 'bronze'], IC = { ouro: '🥇', prata: '🥈', bronze: '🥉' };
      us.forEach(a => { a.medalhaRank = null; });
      top.forEach((a, i) => { a.medalhaRank = M[i]; msg(a, { t: 'sistema', title: 'Medalha do ranking mensal', body: 'Você terminou em ' + (i + 1) + 'º lugar e ganhou a medalha de ' + M[i] + ' ' + IC[M[i]] + '.' }); });
      us.forEach(a => { a.monthScore = 0; });
    }
    db.month = ym; save();
  }
  for (const c of Object.values(db.clans)) {
    if (c.dis && t >= c.dis) { c.members.forEach(m => { const a = db.users[m.id]; if (a) { a.clanId = null; msg(a, { t: 'clã', title: 'Clã dissolvido', body: 'O clã [' + c.tag + '] ' + c.name + ' foi dissolvido.' }); } }); delete db.clans[c.id]; save(); continue; }
    const ld = db.users[c.leader];
    if (ld && t - ld.last > 30 * DAY && c.vices.length) { // 30 dias inativo → vice mais antigo assume
      const nv = [...c.vices].sort((a, b) => a.since - b.since)[0]; c.vices = c.vices.filter(v => v.id !== nv.id); c.leader = nv.id;
      toAll(c, 'Nova liderança', 'O líder ficou 30 dias inativo. A liderança passou ao vice-líder mais antigo.'); save();
    }
  }
}

/* ===== rotas ===== */
const PUBLIC = {}, PRIV = {}, ADMIN = {};
PUBLIC['GET /api/ping'] = () => ({ ok: true, name: 'riverbed', v: 1, now: now() });
PUBLIC['GET /api/nick'] = ({ q }) => { const r = checkNick(q.get('n')); return { available: !r, reason: r }; };
PUBLIC['POST /api/register'] = ({ b, req }) => {
  limit(req, 'reg', 6, 60e3);
  const nick = String(b.nick || '').trim(), pw = String(b.pw || '');
  const r = checkNick(nick); if (r) E(r, r.includes('uso') ? 409 : 400);
  if (pw.length < 6 || pw.length > 64) E('A senha deve ter de 6 a 64 caracteres.');
  const u = newUser(nick, pw); return startSession(u);
};
PUBLIC['POST /api/login'] = ({ b, req }) => {
  limit(req, 'login', 12, 60e3);
  const nick = String(b.nick || '').trim().toLowerCase(), f = fails.get(nick);
  if (f && f.n >= 8 && now() - f.t < 10 * 60e3) E('Conta bloqueada por 10 minutos após muitas tentativas.', 429);
  const u = db.users[db.nicks[nick]];
  if (!u || !safeEq(hashPw(String(b.pw || ''), u.salt), u.hash)) { fails.set(nick, { n: (f && now() - f.t < 10 * 60e3 ? f.n : 0) + 1, t: now() }); E('Nick ou senha incorretos.', 401); }
  fails.delete(nick); u.last = now(); userMaint(u); save(); return startSession(u);
};
function startSession(u) { const token = crypto.randomBytes(32).toString('hex'); db.sessions[token] = { uid: u.id, exp: now() + 30 * DAY }; save(); return Object.assign({ token }, ok(u)); }
PRIV['POST /api/logout'] = ({ req }) => { delete db.sessions[tokenOf(req)]; save(); return { ok: true }; };
PRIV['GET /api/me'] = ({ u }) => ok(u);

PRIV['POST /api/stats'] = ({ u, b }) => { // progresso do modo offline, com limites por envio
  const t = now(); if (u._st && t - u._st < 2000) return ok(u); u._st = t;
  const d = b.d || {}, mx = b.mx || {};
  for (const k in DELTA_CAP) { const v = num(d[k], 0, DELTA_CAP[k]); if (v) u.stats[k] = (u.stats[k] || 0) + v; }
  for (const k in MAX_CAP) { const v = num(mx[k], 0, MAX_CAP[k]); if (v > (u.stats[k] || 0)) u.stats[k] = v; }
  if (u.daily.d !== today()) u.daily = { d: today(), base: 0, sc: 0 };
  const sc = Math.min(num(b.sc, 0, SCORE_PER_SEND), SCORE_PER_DAY - u.daily.sc);
  if (sc > 0) { u.daily.sc += sc; u.score += sc; u.monthScore += sc; }
  const newAch = checkAch(u); save(); return ok(u, { newAch });
};
PRIV['POST /api/event'] = ({ u, b }) => {
  if (b.type !== 'baseKill') E('Evento inválido');
  if (u.daily.d !== today()) u.daily = { d: today(), base: 0, sc: 0 };
  if (u.daily.base >= BASEKILL_PER_DAY) return ok(u, { toast: 'Limite diário de recompensas por bases atingido.' });
  u.daily.base++; u.dia += 5; msg(u, { t: 'sistema', title: 'Base inimiga derrotada', body: 'Você ganhou +5 💎 por destruir uma base inimiga.' });
  save(); return ok(u, { toast: '+5 💎 por derrotar uma base inimiga' });
};
PRIV['POST /api/claim'] = ({ u, b }) => {
  const m = u.msgs.find(x => x.id === String(b.id));
  if (!m || !m.claim) E('Mensagem inválida'); if (m.claim.done) E('Prêmio já resgatado');
  m.claim.done = true; u.dia += m.claim.n; save(); return ok(u, { toast: '+' + m.claim.n + ' 💎 resgatados!' });
};
PRIV['POST /api/msgs/read'] = ({ u }) => { u.msgs.forEach(m => { m.read = true; }); save(); return ok(u); };
PRIV['POST /api/msgs/clear'] = ({ u }) => { u.msgs = u.msgs.filter(m => m.claim && !m.claim.done); save(); return ok(u); }; // mantém prêmios pendentes
PRIV['POST /api/redeem'] = ({ u, b, req }) => {
  limit(req, 'redeem', 15, 60e3);
  const code = String(b.code || '').trim().toLowerCase(); if (!code) E('Digite um cupom');
  if (PROMOS[code]) {
    if (u.promo[code]) E('Você já resgatou este cupom');
    u.promo[code] = now(); u.dia += PROMOS[code]; u.stats.coupon = 1;
    msg(u, { t: 'sistema', title: 'Cupom resgatado', body: 'Cupom ' + code.toUpperCase() + ': +' + PROMOS[code] + ' 💎.' });
    const na = checkAch(u); save(); return ok(u, { toast: '+' + PROMOS[code] + ' 💎 recebidos!', newAch: na });
  }
  const owner = Object.values(db.users).find(x => x.couponCode === code) || (INFL[code] && db.users[db.nicks[INFL[code]]]) || null;
  if (!owner && !INFL[code]) E('Cupom inválido');
  if (u.redeemed) E('Você já resgatou um cupom de influenciador');
  if (owner ? owner.id === u.id : INFL[code] === u.nick.toLowerCase()) E('Você não pode usar o seu próprio cupom');
  u.dia += 50; u.redeemed = code; u.stats.coupon = 1;
  msg(u, { t: 'sistema', title: 'Cupom resgatado', body: 'Você recebeu +50 💎 com o cupom ' + code + '.' });
  if (owner) { owner.dia += 5; msg(owner, { t: 'sistema', title: 'Cupom resgatado', body: u.nick + ' usou o seu cupom: +5 💎 para você.' }); }
  else db.credits[code] = (db.credits[code] || 0) + 1;
  const na = checkAch(u); save(); return ok(u, { toast: '+50 💎 recebidos!', newAch: na });
};
PRIV['POST /api/card'] = ({ u, b }) => {
  const k = String(b.k); if (!CARDS[k]) E('Cartão inválido'); if (u.dia < CARD_PRICE) E('Diamantes insuficientes');
  u.dia -= CARD_PRICE; const e = Math.max(now(), u.cartoesMercado[k] || 0) + DAY; u.cartoesMercado[k] = e;
  msg(u, { t: 'compra', title: 'Compra confirmada: ' + CARDS[k][0], body: 'Cartão de ' + CARDS[k][1] + ' por ' + CARD_PRICE + ' 💎. Válido até ' + new Date(e).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' }) + '.' });
  save(); return ok(u, { toast: 'Compra confirmada!' });
};
PRIV['GET /api/rank'] = () => {
  const us = Object.values(db.users).sort((a, b) => b.monthScore - a.monthScore || a.nick.localeCompare(b.nick)).slice(0, 50);
  return { list: us.map(card), clans: Object.values(db.clans).map(clanPub), month: db.month };
};
const clanPub = c => ({ id: c.id, name: c.name, tag: c.tag, logo: c.logo, leader: c.leader, vices: c.vices, members: c.members, dis: c.dis, lastNotice: 0 });
PRIV['GET /api/clans'] = ({ u }) => {
  const mine = myClan(u), st = staffOf(u);
  const clans = Object.values(db.clans).map(c => Object.assign(clanPub(c), { req: st && st.id === c.id ? c.req : c.req.includes(u.id) ? [u.id] : [], bans: [] }));
  const ids = new Set(); if (mine) { mine.members.forEach(m => ids.add(m.id)); if (st) mine.req.forEach(i => ids.add(i)); }
  Object.values(db.clans).forEach(c => ids.add(c.leader));
  return { clans, users: [...ids].map(i => db.users[i]).filter(Boolean).map(card), me: pub(u) };
};
PRIV['POST /api/clan/create'] = ({ u, b }) => {
  if (u.clanId) E('Você já está em um clã');
  const name = String(b.name || '').trim().replace(/\s+/g, ' '), tag = String(b.tag || '').trim().toUpperCase();
  if (!/^[\p{L}\p{N} _.-]{3,20}$/u.test(name)) E('O nome do clã deve ter de 3 a 20 caracteres (letras, números, espaço, _ . -)');
  if (!/^[A-Z]{3}$/.test(tag)) E('A tag deve ter exatamente 3 letras (A-Z)');
  if (!b.logo) E('Escolha uma logo');
  const cs = Object.values(db.clans);
  if (cs.some(c => c.name.toLowerCase() === name.toLowerCase())) E('Já existe um clã com este nome', 409);
  if (cs.some(c => c.tag === tag)) E('Esta tag já está em uso', 409);
  const id = 'c' + rid(), t = now();
  db.clans[id] = { id, name, tag, logo: cleanLogo(b.logo), leader: u.id, vices: [], members: [{ id: u.id, since: t }], req: [], bans: [], dis: null, lastNotice: 0, created: t };
  u.clanId = id; u.stats.clan = 1; const na = checkAch(u); save(); return ok(u, { toast: 'Clã criado!', newAch: na });
};
PRIV['POST /api/clan/join'] = ({ u, b }) => {
  if (u.clanId) E('Você já está em um clã');
  const c = db.clans[String(b.id)]; if (!c) E('Clã não encontrado', 404);
  if (c.bans.includes(u.id)) E('Você foi banido deste clã', 403); if (c.req.includes(u.id)) E('Pedido já enviado'); if (c.members.length >= 30) E('Clã cheio');
  c.req.push(u.id); [c.leader, ...c.vices.map(v => v.id)].forEach(i => { const a = db.users[i]; if (a) msg(a, { t: 'clã', title: 'Novo pedido de entrada', body: u.nick + ' quer entrar no clã.' }); });
  save(); return ok(u, { toast: 'Pedido enviado ao líder e aos vice-líderes' });
};
const needStaff = u => { const c = staffOf(u); if (!c) E('Sem permissão', 403); return c; };
const needLeader = u => { const c = myClan(u); if (!c || c.leader !== u.id) E('Apenas o líder pode fazer isso', 403); return c; };
PRIV['POST /api/clan/accept'] = ({ u, b }) => {
  const c = needStaff(u), uid = String(b.uid), a = db.users[uid];
  if (!c.req.includes(uid) || !a) E('Pedido não encontrado'); if (c.members.length >= 30) E('Clã cheio'); if (a.clanId) { c.req = c.req.filter(i => i !== uid); save(); E('Este jogador já entrou em outro clã'); }
  c.req = c.req.filter(i => i !== uid); c.members.push({ id: uid, since: now() }); a.clanId = c.id; a.stats.clan = 1;
  msg(a, { t: 'clã', title: 'Pedido aceito', body: 'Você entrou no clã [' + c.tag + '] ' + c.name + '.' }); checkAch(a); save(); return ok(u);
};
PRIV['POST /api/clan/ban'] = ({ u, b }) => {
  const c = needStaff(u), uid = String(b.uid), mr = role(c, u.id), tr = role(c, uid), isReq = c.req.includes(uid);
  if (!tr && !isReq) E('Jogador não está no clã'); if (uid === u.id || tr === 'lider') E('Ação inválida');
  if (mr === 'vice' && tr === 'vice') E('Vice-líderes não banem outros vice-líderes', 403);
  c.members = c.members.filter(m => m.id !== uid); c.vices = c.vices.filter(v => v.id !== uid); c.req = c.req.filter(i => i !== uid); if (!c.bans.includes(uid)) c.bans.push(uid);
  const a = db.users[uid]; if (a) { if (a.clanId === c.id) a.clanId = null; msg(a, { t: 'clã', title: 'Banido do clã', body: 'Você foi banido do clã [' + c.tag + '] ' + c.name + '.' }); }
  save(); return ok(u);
};
PRIV['POST /api/clan/promote'] = ({ u, b }) => {
  const c = needLeader(u), uid = String(b.uid);
  if (c.vices.length >= 3) E('Máximo de 3 vice-líderes'); if (role(c, uid) !== 'membro') E('Ação inválida');
  c.vices.push({ id: uid, since: now() }); const a = db.users[uid]; if (a) msg(a, { t: 'clã', title: 'Você é vice-líder', body: 'Agora você pode aceitar e banir membros.' }); save(); return ok(u);
};
PRIV['POST /api/clan/demote'] = ({ u, b }) => { const c = needLeader(u); c.vices = c.vices.filter(v => v.id !== String(b.uid)); save(); return ok(u); };
PRIV['POST /api/clan/transfer'] = ({ u, b }) => {
  const c = needLeader(u), uid = String(b.uid); if (role(c, uid) !== 'vice') E('Escolha um vice-líder');
  c.vices = c.vices.filter(v => v.id !== uid); c.leader = uid; toAll(c, 'Nova liderança', 'A liderança do clã foi passada.'); save(); return ok(u);
};
PRIV['POST /api/clan/dissolve'] = ({ u }) => { const c = needLeader(u); c.dis = now() + 3 * DAY; toAll(c, 'Dissolução iniciada', 'O clã será dissolvido em 3 dias, a menos que o líder restabeleça.'); save(); return ok(u); };
PRIV['POST /api/clan/restore'] = ({ u }) => { const c = needLeader(u); c.dis = null; toAll(c, 'Clã restabelecido', 'A dissolução do clã foi cancelada.'); save(); return ok(u); };
PRIV['POST /api/clan/notice'] = ({ u, b }) => {
  const c = needLeader(u), txt = String(b.text || '').trim();
  if (txt.length < 3 || txt.length > 200) E('O aviso deve ter de 3 a 200 caracteres');
  if (now() - c.lastNotice < DAY) E('Você já enviou um aviso nas últimas 24 horas', 429);
  c.lastNotice = now(); toAll(c, 'Aviso do clã [' + c.tag + ']', txt); save(); return ok(u, { toast: 'Aviso enviado aos membros' });
};
PRIV['POST /api/clan/leave'] = ({ u }) => {
  const c = myClan(u); if (!c) E('Sem clã'); if (c.leader === u.id) E('O líder deve passar a liderança ou dissolver o clã');
  c.members = c.members.filter(m => m.id !== u.id); c.vices = c.vices.filter(v => v.id !== u.id); u.clanId = null; save(); return ok(u);
};

/* ----- painel admin (envie o cabeçalho X-Admin-Key) ----- */
const byNick = n => { const u = db.users[db.nicks[String(n || '').toLowerCase()]]; if (!u) E('Jogador não encontrado', 404); return u; };
ADMIN['POST /api/admin/influencer'] = ({ b }) => {
  const u = byNick(b.nick), on = b.on !== false;
  u.isInfluencer = on; if (on && b.coupon) { u.couponCode = String(b.coupon).toLowerCase(); flagInfluencer(u); } if (!on) u.couponCode = null;
  save(); return { ok: true, nick: u.nick, isInfluencer: u.isInfluencer, couponCode: u.couponCode };
};
ADMIN['POST /api/admin/msg'] = ({ b }) => {
  const claim = b.claim ? num(b.claim, 1, 1000) : 0, m = { t: 'suporte', title: String(b.title || '').slice(0, 80), body: String(b.body || '').slice(0, 500), claim };
  if (!m.title || !m.body) E('Informe title e body');
  const list = b.to === 'all' ? Object.values(db.users) : [byNick(b.to)]; list.forEach(u => msg(u, m)); save(); return { ok: true, enviadas: list.length };
};
ADMIN['POST /api/admin/grant'] = ({ b }) => { const u = byNick(b.nick), n = num(b.dia, -100000, 100000); u.dia = Math.max(0, u.dia + n); msg(u, { t: 'recarga', title: 'Diamantes creditados', body: (n >= 0 ? '+' : '') + n + ' 💎 foram ajustados na sua conta pelo suporte.' }); save(); return { ok: true, dia: u.dia }; };
ADMIN['GET /api/admin/stats'] = () => ({ jogadores: Object.keys(db.users).length, cla: Object.keys(db.clans).length, sessoes: Object.keys(db.sessions).length, mes: db.month });

/* ===== HTTP ===== */
const tokenOf = req => String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
function authUser(req) {
  const tk = tokenOf(req), s = tk && db.sessions[tk]; if (!s) return null;
  if (s.exp < now()) { delete db.sessions[tk]; save(); return null; }
  const u = db.users[s.uid]; if (!u) return null;
  if (now() - u.last > 5 * 60e3) { u.last = now(); save(); }
  userMaint(u); return u;
}
function readBody(req) {
  return new Promise((res, rej) => {
    let n = 0; const ch = [];
    req.on('data', c => { n += c.length; if (n > 1e5) { rej(new HttpErr('Corpo muito grande', 413)); req.destroy(); } else ch.push(c); });
    req.on('end', () => { try { res(ch.length ? JSON.parse(Buffer.concat(ch).toString('utf8')) : {}); } catch (e) { rej(new HttpErr('JSON inválido')); } });
    req.on('error', rej);
  });
}
function send(res, status, obj) { const s = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(s); }
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
function serveStatic(p, res) {
  let f = path.normalize(path.join(PUB, p === '/' ? 'index.html' : decodeURIComponent(p)));
  if (!f.startsWith(PUB)) { res.writeHead(403); return res.end('Proibido'); }
  fs.readFile(f, (e, d) => { if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Não encontrado'); } res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(d); });
}
async function onReq(req, res) {
  res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*'); res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization, x-admin-key'); res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = new URL(req.url, 'http://x'), p = url.pathname;
    if (!p.startsWith('/api/')) return serveStatic(p, res);
    const key = req.method + ' ' + p, body = req.method === 'POST' ? await readBody(req) : {}, ctx = { b: body, q: url.searchParams, req };
    maintGlobal(); let out;
    if (PUBLIC[key]) out = PUBLIC[key](ctx);
    else if (PRIV[key]) { const u = authUser(req); if (!u) E('Sessão expirada. Entre novamente.', 401); ctx.u = u; out = PRIV[key](ctx); }
    else if (ADMIN[key]) { const k = String(req.headers['x-admin-key'] || ''); if (!ADMIN_KEY || !safeEq(k, ADMIN_KEY)) E('Admin desativado ou chave inválida', 403); out = ADMIN[key](ctx); }
    else E('Rota não encontrada', 404);
    send(res, 200, out);
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.s, { err: e.message });
    console.error(e); send(res, 500, { err: 'Erro interno do servidor' });
  }
}
function start(port = PORT) {
  load(); maintGlobal(true);
  const srv = http.createServer(onReq);
  srv.listen(port, HOST, () => console.log('Riverbed Warfare: servidor em http://localhost:' + srv.address().port + ' (dados em ' + DATA_DIR + ')' + (ADMIN_KEY ? '' : ' · admin desativado (defina ADMIN_KEY)')));
  const bye = () => { writeNow(); process.exit(0); }; process.on('SIGINT', bye); process.on('SIGTERM', bye);
  return srv;
}
if (require.main === module) start();
module.exports = { start, state: () => db, maintGlobal, flush: writeNow }; // usados pelo teste (npm test)
