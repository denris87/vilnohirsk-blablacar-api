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

// API для отримання поїздок
app.get('/api/rides', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rides = await Ride.find({ date: { $gte: today } }).select('-ownerUid').sort({ date: 1, time: 1 });
    res.json(rides);
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
    const newRide = new Ride(body);
    await newRide.save();
    res.status(201).json(publicRide(newRide));
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
