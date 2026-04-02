const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Максимально відкритий CORS для обходу будь-яких блокувань Telegram
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS'],
  allowedHeaders: '*'
}));
app.use(express.json());

// Тестовий маршрут, щоб перевірити, чи сервер взагалі "живий"
app.get('/', (req, res) => {
  res.status(200).send('Сервер BlaBlaCar працює успішно!');
});

// Підключення до бази даних MongoDB
const MONGO_URI = process.env.MONGO_URI;

if (!MONGO_URI) {
  console.error('❌ КРИТИЧНА ПОМИЛКА: Не вказано MONGO_URI у Railway (Settings -> Variables)!');
} else {
  mongoose.connect(MONGO_URI)
    .then(() => console.log('✅ Успішно підключено до MongoDB!'))
    .catch(err => console.error('❌ Помилка підключення до MongoDB:', err));
}

// Схема для поїздки
const rideSchema = new mongoose.Schema({
  type: { type: String, required: true },
  from: { type: String, required: true },
  to: { type: String, required: true },
  date: { type: String, required: true },
  time: { type: String, required: true },
  seats: { type: Number, required: true },
  price: { type: Number },
  phone: { type: String, required: true },
  comment: { type: String },
  createdAt: { type: Date, default: Date.now }
});

const Ride = mongoose.model('Ride', rideSchema);

// === API 1: ОТРИМАТИ ВСІ ПОЇЗДКИ ===
app.get('/api/rides', async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const rides = await Ride.find({ date: { $gte: today } }).sort({ date: 1, time: 1 });
    res.status(200).json(rides);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Помилка сервера при отриманні поїздок' });
  }
});

// === API 2: ДОДАТИ НОВУ ПОЇЗДКУ ===
app.post('/api/rides', async (req, res) => {
  try {
    const newRide = new Ride(req.body);
    await newRide.save();
    res.status(201).json({ message: '✅ Поїздку успішно додано!', ride: newRide });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Помилка при збереженні поїздки' });
  }
});

// === API 3: ВИДАЛИТИ ПОЇЗДКУ ===
app.delete('/api/rides/:id', async (req, res) => {
  try {
    await Ride.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: '✅ Поїздку видалено!' });
  } catch (error) {
    res.status(500).json({ error: 'Помилка при видаленні поїздки' });
  }
});

// Запуск сервера (0.0.0.0 обов'язково для Railway)
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Сервер BlaBlaCar працює на порту ${PORT}`);
});
