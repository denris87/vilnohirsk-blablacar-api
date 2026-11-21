const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// Вхід у «Мій кабінет» на сайті — Firebase Authentication (проєкт smart-vilnohirsk).
// Для перевірки токена входу достатньо ID проєкту: ключі не потрібні.
admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'smart-vilnohirsk' });

const app = express();
app.set('trust proxy', true); // Railway стоїть перед сервером: справжня IP-адреса — у X-Forwarded-For

// Налаштування CORS - дозволяємо все і всім для Telegram
app.use(cors());
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization");
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

app.use(express.json({ limit: '50kb' }));

// Головна сторінка для перевірки
app.get('/', (req, res) => {
  res.status(200).send('<h1>Сервер BlaBlaCar LIVE!</h1>');
});

// Підключення до бази
const MONGO_URI = process.env.MONGO_URI;
mongoose.connect(MONGO_URI)
  .then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => console.error('❌ MongoDB error:', err));

const rideSchema = new mongoose.Schema({
  type: String, name: String, from: String, to: String, date: String, time: String,
  seats: Number, price: Number, phone: String, comment: String,
  // Хто подав поїздку з «Мого кабінету» (ID акаунта Firebase). Назовні не віддаємо.
  ownerUid: { type: String, index: true },
  // Номер поста в Telegram-чаті попуток — щоб прибрати його, коли поїздку видалять. Назовні не віддаємо.
  tgMessageId: Number,
  createdAt: { type: Date, default: Date.now }
});
const Ride = mongoose.model('Ride', rideSchema);

// Хто робить запит: ID акаунта з токена входу (заголовок «Authorization: Bearer …»).
// null — без входу (як раніше), undefined — токен є, але недійсний.
async function getUid(req) {
  const m = (req.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  try {
    const t = await admin.auth().verifyIdToken(m[1]);
    return t.uid;
  } catch (e) {
    return undefined;
  }
}

// Поїздку віддаємо без ID власника й номера поста
function publicRide(doc) {
  const o = doc.toObject ? doc.toObject() : Object.assign({}, doc);
  delete o.ownerUid; delete o.tgMessageId;
  return o;
}

// === Публікація в Telegram-чаті попуток ===
// Нова поїздка з сайту → пост у чаті; людина видалила поїздку на сайті або її автора заблокували → пост прибираємо.
// Через 3 дні чат сам видаляє старі повідомлення. Токен бота — у змінній Railway TELEGRAM_BOT_TOKEN.
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || '@blablacarvln';
const UA_WEEKDAYS = ['неділя', 'понеділок', 'вівторок', 'середа', 'четвер', "п'ятниця", 'субота'];

function rideDate(d) { // 2026-11-22 → 22.11.2026, субота
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(d || ''));
  if (!m) return String(d || '');
  return `${m[3]}.${m[2]}.${m[1]}, ${UA_WEEKDAYS[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()]}`;
}
function rideTime(t) { // 12:00 або 12:00 - 12:30 → з 12:00 до 12:30
  const p = String(t || '').split(/\s*[-–—]\s*/).filter(Boolean);
  return p.length === 2 ? `з ${p[0]} до ${p[1]}` : String(t || '').trim();
}
function rideText(r) {
  const drv = r.type !== 'passenger', one = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const lines = [
    drv ? '#Водій' : '#Пасажир',
    `Маршрут: ${one(r.from)} → ${one(r.to)}`,
    `Дата: ${rideDate(r.date)}`,
    `Час: ${rideTime(r.time)}`,
    `${drv ? 'Кількість вільних місць' : 'Кількість необхідних місць'}: ${one(r.seats)}`
  ];
  if (Number(r.price) > 0) lines.push(`Ціна: ${Number(r.price)} грн`);
  if (one(r.comment)) lines.push(`Коментар: ${one(r.comment).slice(0, 500)}`);
  lines.push(`Телефон: ${one(r.phone)}`);
  return lines.join('\n');
}

async function tgCall(method, payload) {
  if (!TG_TOKEN) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal
    });
    const d = await r.json().catch(() => ({}));
    if (!d.ok) console.error(`Telegram ${method}: ${d.description || r.status}`);
    return d;
  } catch (e) {
    console.error(`Telegram ${method}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Захист чату від флуду: з однієї адреси — не більше 4 постів на годину, усього — не більше 40 на годину
const tgSent = new Map();
function tgAllowed(ip) {
  const now = Date.now(), hour = 60 * 60 * 1000;
  for (const [k, list] of tgSent) { const fresh = list.filter(t => now - t < hour); if (fresh.length) tgSent.set(k, fresh); else tgSent.delete(k); }
  const mine = tgSent.get(ip) || [], all = [...tgSent.values()].reduce((n, l) => n + l.length, 0);
  if (mine.length >= 4 || all >= 40) return false;
  tgSent.set(ip, mine.concat(now));
  return true;
}

async function tgPostRide(ride, ip) {
  if (!TG_TOKEN) return;
  if (!tgAllowed(ip || '?')) { console.warn('Telegram: забагато постів, поїздку в чат не надсилаємо'); return; }
  const d = await tgCall('sendMessage', { chat_id: TG_CHAT, text: rideText(ride) });
  if (d && d.ok && d.result && d.result.message_id) {
    await Ride.updateOne({ _id: ride._id }, { $set: { tgMessageId: d.result.message_id } }).catch(e => console.error('tgMessageId:', e.message));
  }
}
async function tgDeleteRide(ride) {
  if (!ride || !ride.tgMessageId) return;
  await tgCall('deleteMessage', { chat_id: TG_CHAT, message_id: ride.tgMessageId }); // якщо чат уже прибрав пост — Telegram просто відповість помилкою
}

// === Блокування шахраїв ===
// Список заблокованих веде Apps Script сайту (приватна таблиця «кабінет»): адміністратор блокує
// людину на сайті — її акаунт і телефони. Сервер раз на 2 хвилини питає в Apps Script, хто з авторів
// поточних поїздок заблокований, і не показує їхні поїздки; нові поїздки від них не приймає.
// Ключі й налаштування не потрібні: Apps Script відповідає лише «так/ні» про тих, кого ми питаємо.
const APP_SCRIPT_URL = process.env.APP_SCRIPT_URL || 'https://script.google.com/macros/s/AKfycbxRH8Fg2WThVyFqO3AoMS9cNsz_-G8jI4AkP2Pn6i4PrKnWkB3C6sBcc_6Qhnq_LiAR/exec';
const BANS_TTL = 2 * 60 * 1000;
const bans = { uids: new Set(), phones: new Set(), at: 0, busy: null, again: false };
const phone9 = (p) => { const d = String(p || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; };
const isBanned = (r) => !!((r.ownerUid && bans.uids.has(r.ownerUid)) || bans.phones.has(phone9(r.phone)));

async function askBans(uids, phones) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(APP_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ formType: 'cabinet_bans_for', uids, phones }), signal: ctrl.signal
    });
    const d = await r.json();
    if (!d || d.status !== 'ok') throw new Error((d && (d.message || d.status)) || 'порожня відповідь');
    return { uids: new Set(d.uids || []), phones: new Set(d.phones || []) };
  } finally {
    clearTimeout(timer);
  }
}

// Оновити список (у фоні). Якщо Apps Script не відповів — лишаємо попередній і пробуємо знову за пів хвилини.
function refreshBans() {
  if (bans.busy) { bans.again = true; return bans.busy; }
  bans.busy = (async () => {
    try {
      const today = new Date().toISOString().split('T')[0];
      const rides = await Ride.find({ date: { $gte: today } }).select('ownerUid phone tgMessageId').lean();
      const uids = [...new Set(rides.map(r => r.ownerUid).filter(Boolean))];
      const phones = [...new Set(rides.map(r => phone9(r.phone)).filter(Boolean))];
      const res = (uids.length || phones.length) ? await askBans(uids, phones) : { uids: new Set(), phones: new Set() };
      bans.uids = res.uids; bans.phones = res.phones; bans.at = Date.now();
      // Пости заблокованих — геть із Telegram-чату
      for (const r of rides.filter(x => x.tgMessageId && isBanned(x))) {
        await tgDeleteRide(r);
        await Ride.updateOne({ _id: r._id }, { $unset: { tgMessageId: 1 } });
      }
    } catch (e) {
      console.error('Блокування: не вдалося оновити список —', e.message);
      bans.at = Date.now() - BANS_TTL + 30 * 1000;
    } finally {
      bans.busy = null;
      if (bans.again) { bans.again = false; refreshBans(); }
    }
  })();
  return bans.busy;
}

// API для отримання поїздок (без поїздок заблокованих)
app.get('/api/rides', async (req, res) => {
  try {
    if (!bans.at) await Promise.race([refreshBans(), new Promise(r => setTimeout(r, 3000))]); // щойно запустились
    else if (Date.now() - bans.at > BANS_TTL) refreshBans(); // у фоні
    const today = new Date().toISOString().split('T')[0];
    const rides = await Ride.find({ date: { $gte: today } }).sort({ date: 1, time: 1 });
    res.json(rides.filter(r => !isBanned(r)).map(publicRide));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API для додавання поїздки. З кабінету (є вхід) — поїздка запам'ятовує свого власника.
app.post('/api/rides', async (req, res) => {
  try {
    const uid = await getUid(req);
    if (uid === undefined) return res.status(401).json({ error: 'Вхід застарів. Увійдіть ще раз.' });
    const body = Object.assign({}, req.body);
    delete body._id; delete body.ownerUid; delete body.createdAt;
    if (uid) body.ownerUid = uid;
    if ((uid && bans.uids.has(uid)) || bans.phones.has(phone9(body.phone))) {
      return res.status(403).json({ error: 'Подавати поїздки з цього акаунта або номера заборонено. Якщо це помилка — напишіть @vilnohirsk.' });
    }
    const newRide = new Ride(body);
    await newRide.save();
    res.status(201).json(publicRide(newRide));
    // У фоні: перевірити нового автора (заблокованого не покажемо) і, якщо все гаразд, опублікувати в Telegram-чаті
    (async () => {
      await refreshBans();
      if (bans.busy) await bans.busy;
      if (!isBanned(newRide)) await tgPostRide(newRide, req.ip);
    })().catch(e => console.error('Публікація поїздки:', e.message));
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// «Мої оголошення» в кабінеті: усі поїздки цього акаунта (і минулі)
app.get('/api/my-rides', async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return res.status(401).json({ error: 'Потрібен вхід' });
  try {
    const rides = await Ride.find({ ownerUid: uid }).select('-ownerUid -tgMessageId').sort({ date: -1, time: -1 }).limit(100);
    res.json(rides);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Видалити свою поїздку (лише власник)
app.delete('/api/rides/:id', async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return res.status(401).json({ error: 'Потрібен вхід' });
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).json({ error: 'Поїздку не знайдено' });
  try {
    const ride = await Ride.findOne({ _id: req.params.id, ownerUid: uid });
    if (!ride) return res.status(404).json({ error: 'Поїздку не знайдено або вона не ваша' });
    await Ride.deleteOne({ _id: ride._id });
    res.json({ ok: true });
    tgDeleteRide(ride).catch(() => {}); // і з Telegram-чату
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
});
