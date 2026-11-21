const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// Вхід у «Мій кабінет» на сайті — Firebase Authentication (проєкт smart-vilnohirsk).
// Для перевірки токена входу достатньо ID проєкту: ключі не потрібні.
admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'smart-vilnohirsk' });

const app = express();

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

// Поїздку віддаємо без ID власника
function publicRide(doc) {
  const o = doc.toObject ? doc.toObject() : Object.assign({}, doc);
  delete o.ownerUid;
  return o;
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
      const rides = await Ride.find({ date: { $gte: today } }).select('ownerUid phone').lean();
      const uids = [...new Set(rides.map(r => r.ownerUid).filter(Boolean))];
      const phones = [...new Set(rides.map(r => phone9(r.phone)).filter(Boolean))];
      const res = (uids.length || phones.length) ? await askBans(uids, phones) : { uids: new Set(), phones: new Set() };
      bans.uids = res.uids; bans.phones = res.phones; bans.at = Date.now();
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
    refreshBans(); // перевірити нового автора (у фоні): якщо заблокований — поїздку не покажемо
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// «Мої оголошення» в кабінеті: усі поїздки цього акаунта (і минулі)
app.get('/api/my-rides', async (req, res) => {
  const uid = await getUid(req);
  if (!uid) return res.status(401).json({ error: 'Потрібен вхід' });
  try {
    const rides = await Ride.find({ ownerUid: uid }).select('-ownerUid').sort({ date: -1, time: -1 }).limit(100);
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
    const r = await Ride.deleteOne({ _id: req.params.id, ownerUid: uid });
    if (!r.deletedCount) return res.status(404).json({ error: 'Поїздку не знайдено або вона не ваша' });
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
});
