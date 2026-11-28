const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const admin = require('firebase-admin');
require('dotenv').config();

// Вхід у «Мій кабінет» на сайті — Firebase Authentication (проєкт smart-vilnohirsk).
// Для перевірки токена входу достатньо ID проєкту: ключі не потрібні.
admin.initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'smart-vilnohirsk' });

const app = express();
app.disable('x-powered-by'); // не підказуємо, на чому працює сервер

// Справжня IP-адреса людини. Railway стоїть перед сервером і ДОПИСУЄ її в кінець X-Forwarded-For;
// усе, що лівіше, могла вписати сама людина (підробити), тому беремо першу ззовні адресу справа.
function isPrivateIp(ip) {
  ip = String(ip || '').toLowerCase();
  const v4 = /^(\d+)\.(\d+)\.\d+\.\d+$/.exec(ip);
  if (v4) {
    const a = +v4[1], b = +v4[2];
    return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254);
  }
  return !ip || ip === '::1' || ip === '::' || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}
function cleanIp(ip) {
  ip = String(ip || '').trim().replace(/^\[([^\]]+)\](:\d+)?$/, '$1').replace(/^(\d+\.\d+\.\d+\.\d+):\d+$/, '$1');
  return ip.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
}
function clientIp(req) {
  const chain = String(req.headers['x-forwarded-for'] || '').split(',').map(cleanIp).filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) if (!isPrivateIp(chain[i])) return chain[i];
  return cleanIp(req.socket && req.socket.remoteAddress) || '?';
}

app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});

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
  .then(() => { console.log('✅ Connected to MongoDB'); sweepPastRides(); })
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

// Що саме приймаємо від сайту. Лише ці поля — службові (власник, номер поста в чаті, дата створення)
// ставить тільки сервер. Довгий текст обрізаємо, явно неправильне — не приймаємо.
const RIDE_DAY = 24 * 60 * 60 * 1000;

// === Дата й час за Києвом ===
// Сервер на Railway живе за UTC, а в місті — київський час (взимку UTC+2, улітку UTC+3). Дата й час поїздки
// записані «як у Києві», тож і «зараз» рахуємо за київським годинником: за UTC поїздки зникали б на 2–3 години пізніше.
let kyivFmt = null;
try {
  kyivFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kiev', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
} catch (e) {
  console.warn('Немає бази часових поясів — київський час рахуємо самі');
}
// Момент → київський «настінний» час числом, з точністю до хвилини: 25.11.2026 14:30 у Києві → Date.UTC(2026, 10, 25, 14, 30).
// Такі числа можна прямо порівнювати з датою й часом поїздки.
function kyivWall(at) {
  const d = new Date(at === undefined ? Date.now() : at);
  if (kyivFmt) {
    const p = {};
    kyivFmt.formatToParts(d).forEach(x => { p[x.type] = x.value; });
    if (p.year && p.month && p.day && p.hour && p.minute) return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  }
  // Запасний шлях: UTC+2, а з останньої неділі березня до останньої неділі жовтня (з 01:00 UTC) — UTC+3
  const y = d.getUTCFullYear();
  const lastSunday = (m) => { const end = new Date(Date.UTC(y, m + 1, 0)); return Date.UTC(y, m, end.getUTCDate() - end.getUTCDay(), 1); };
  const t = d.getTime(), shift = t >= lastSunday(2) && t < lastSunday(9) ? 3 : 2;
  return Math.floor((t + shift * 3600 * 1000) / 60000) * 60000;
}
function kyivToday(at) { // → '2026-11-24'
  return new Date(kyivWall(at)).toISOString().slice(0, 10);
}
function dayShift(day, n) { // '2026-11-24', -2 → '2026-11-22' (календарні дні)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + n)).toISOString().slice(0, 10) : String(day);
}
function rideField(v, lines) {
  if (typeof v !== 'string' && typeof v !== 'number') return '';
  v = String(v).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ''); // керівні символи — геть
  return (lines ? v.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n') : v.replace(/\s+/g, ' ')).trim();
}
// === Коли поїздка минула ===
// Поїздку видно на сайті й у чаті, доки не мине година після її часу за Києвом: «25.11 о 12:00» — до 13:00,
// «з 12:00 до 12:30» — до 13:30, «з 23:30 до 00:30» — до 01:30 наступного дня.
const RIDE_GRACE = 60 * 60 * 1000;
function rideMinutes(t) { // '12:00' → [720, 720]; '12:00 - 12:30' → [720, 750]; '23:30 - 00:30' → [1410, 1470]; не розібрати → null
  const all = (String(t || '').match(/\d{1,2}:\d{2}/g) || []).map(x => { const [h, m] = x.split(':').map(Number); return h < 24 && m < 60 ? h * 60 + m : NaN; });
  if (!all.length || all.some(isNaN)) return null;
  const from = all[0];
  let to = all[all.length - 1];
  if (to < from) to += 24 * 60; // кінець — уже після півночі
  return [from, to];
}
// Київський «настінний» момент, коли поїздку прибираємо; null — дата не у форматі 2026-11-25
function rideEndsAt(r) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(r.date || ''));
  if (!dm) return null;
  const day = Date.UTC(+dm[1], +dm[2] - 1, +dm[3]), mins = rideMinutes(r.time);
  return mins ? day + mins[1] * 60000 + RIDE_GRACE : day + RIDE_DAY; // час не розібрати — як раніше: до кінця доби
}
function rideIsPast(r, now) {
  now = now === undefined ? Date.now() : now;
  const end = rideEndsAt(r);
  if (end !== null) return kyivWall(now) >= end;
  // Дата не у форматі 2026-11-25 (так могли записатись дуже старі поїздки) — прибираємо, коли поїздці понад тиждень
  const made = r.createdAt ? new Date(r.createdAt).getTime() : 0;
  return !made || now - made > 7 * RIDE_DAY;
}
function cleanRide(b) {
  b = b && typeof b === 'object' ? b : {};
  const type = rideField(b.type);
  if (type !== 'driver' && type !== 'passenger') return { error: 'Оберіть: ви водій чи пасажир.' };
  const from = rideField(b.from).slice(0, 40), to = rideField(b.to).slice(0, 40);
  if (!from || !to) return { error: 'Вкажіть, звідки і куди їдете.' };
  const date = rideField(b.date);
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const day = dm ? Date.UTC(+dm[1], +dm[2] - 1, +dm[3]) : NaN;
  if (!dm || new Date(day).getUTCDate() !== +dm[3] || day > Date.now() + 366 * RIDE_DAY) {
    return { error: 'Перевірте дату поїздки.' };
  }
  if (date < kyivToday()) return { error: 'Ця дата вже минула. Оберіть сьогодні або пізніший день.' };
  const time = rideField(b.time);
  if (!/^\d{1,2}:\d{2}(\s*[-–—]\s*\d{1,2}:\d{2})?$/.test(time) || !rideMinutes(time)) return { error: 'Перевірте час поїздки.' };
  if (rideIsPast({ date, time })) return { error: 'Час цієї поїздки вже минув. Перевірте дату й час.' };
  const seats = Number(b.seats);
  if (!Number.isInteger(seats) || seats < 1 || seats > 8) return { error: 'Перевірте кількість місць.' };
  const price = b.price === undefined || b.price === null || b.price === '' ? 0 : Number(b.price);
  if (!Number.isInteger(price) || price < 0 || price > 999999) return { error: 'Перевірте ціну.' };
  const phone = rideField(b.phone), digits = phone.replace(/\D/g, '');
  if (phone.length > 25 || !/^[+\d\s()-]+$/.test(phone) || digits.length < 10 || digits.length > 13) return { error: 'Перевірте номер телефону.' };
  return { ride: { type, name: rideField(b.name).slice(0, 40), from, to, date, time, seats, price, phone, comment: rideField(b.comment, true).slice(0, 1000) } };
}

// Захист від флуду поїздками: з однієї адреси — не більше 10 на годину, усього — не більше 80 на годину
const postsByIp = new Map();
function postAllowed(ip) {
  const now = Date.now(), hour = 60 * 60 * 1000;
  let all = 0;
  for (const [k, list] of postsByIp) {
    const fresh = list.filter(t => now - t < hour);
    if (fresh.length) { postsByIp.set(k, fresh); all += fresh.length; } else postsByIp.delete(k);
  }
  const mine = postsByIp.get(ip) || [];
  if (mine.length >= 10 || all >= 80) return false;
  postsByIp.set(ip, mine.concat(now));
  return true;
}

// Назовні — лише загальне повідомлення; подробиці помилки — у журнал Railway
function serverError(res, where, error) {
  console.error(where + ':', error && error.message || error);
  res.status(500).json({ error: 'Помилка сервера. Спробуйте трохи пізніше.' });
}

// Поїздку віддаємо без ID власника й номера поста
function publicRide(doc) {
  const o = doc.toObject ? doc.toObject() : Object.assign({}, doc);
  delete o.ownerUid; delete o.tgMessageId;
  return o;
}

// === Публікація в Telegram-чаті попуток ===
// Нова поїздка з сайту → пост у чаті; людина видалила поїздку на сайті або її автора заблокували → пост прибираємо.
// Минула година після часу поїздки — пост теж прибираємо (див. «Минулі поїздки» нижче).
// Токен бота — у змінній Railway TELEGRAM_BOT_TOKEN.
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
// Шаблон — жирним, те, що вписала людина, — звичайним (розмітка HTML, тож її текст екрануємо)
function rideText(r) {
  const drv = r.type !== 'passenger';
  const one = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
  const esc = (v) => one(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const b = (label) => `<b>${label}</b>`;
  const lines = [
    drv ? `🚗 ${b('#Водій')}` : `🧍 ${b('#Пасажир')}`,
    `📍 ${b('Маршрут:')} ${esc(r.from)} → ${esc(r.to)}`,
    `🗓 ${b('Дата:')} ${esc(rideDate(r.date))}`,
    `🕐 ${b('Час:')} ${esc(rideTime(r.time))}`,
    `💺 ${b(drv ? 'Кількість вільних місць:' : 'Кількість необхідних місць:')} ${esc(r.seats)}`
  ];
  if (Number(r.price) > 0) lines.push(`💰 ${b('Ціна:')} ${Number(r.price)} грн`);
  if (one(r.comment)) lines.push(`💬 ${b('Коментар:')} ${esc(one(r.comment).slice(0, 500))}`);
  lines.push(`📞 ${b('Телефон:')} ${esc(r.phone)}`);
  // Підпис: щоб люди знали, де подати таке оголошення
  lines.push('------------------', '<i>оголошення опубліковано через сайт</i> <b><a href="https://vilnohirsk.online">vilnohirsk.online</a></b>');
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
  const d = await tgCall('sendMessage', { chat_id: TG_CHAT, text: rideText(ride), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  if (d && d.ok && d.result && d.result.message_id) {
    await Ride.updateOne({ _id: ride._id }, { $set: { tgMessageId: d.result.message_id } }).catch(e => console.error('tgMessageId:', e.message));
  }
}
async function tgDeleteRide(ride) {
  if (!ride || !ride.tgMessageId) return;
  await tgCall('deleteMessage', { chat_id: TG_CHAT, message_id: ride.tgMessageId }); // якщо чат уже прибрав пост — Telegram просто відповість помилкою
}

// === Минулі поїздки: через годину після часу поїздки — геть із сайту й із Telegram-чату ===
// Поїздку «25.11 о 12:00» видно до 13:00 25.11 за Києвом. Потім вона одразу зникає зі списку на сайті (список віддає
// лише поїздки, що ще не минули), а щойно сервер це помітить (перевіряє щохвилини й одразу після запуску) —
// її пост видаляється з чату, а сама поїздка — з бази (тож і з «Моїх оголошень» у кабінеті).
// Telegram дає боту видаляти лише пости, молодші за 48 годин. Старіший пост бот не видалить — тоді замінює його
// текст на «Поїздка вже відбулася» (без телефону). Не вийшло через збій Telegram — пробуємо знову за 10 хвилин.
const SWEEP_EVERY = 60 * 1000, SWEEP_RETRY = 10 * 60 * 1000;
const sweep = { busy: null, next: 0 }; // next — не раніше якого моменту прибирати знову
const pause = (ms) => new Promise(r => setTimeout(r, ms));

function rideGoneText(r) {
  const esc = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `${r.type === 'passenger' ? '🧍' : '🚗'} <s>${esc(r.from)} → ${esc(r.to)}, ${esc(rideDate(r.date))}</s>\n⌛ <i>Поїздка вже відбулася — оголошення знято.</i>`;
}
// Пост минулої поїздки: 'deleted' — видалили, 'edited' — замінили текст, 'gone' — поста вже немає або більше нічого
// не вдієш, 'retry' — збій (спробуємо пізніше), 'wait' — Telegram просить зачекати
async function tgExpireRide(r) {
  const verdict = (d, ok) => d && d.ok ? ok : !d || !d.error_code || d.error_code >= 500 ? 'retry' : d.error_code === 429 ? 'wait' : '';
  const del = await tgCall('deleteMessage', { chat_id: TG_CHAT, message_id: r.tgMessageId });
  const v = verdict(del, 'deleted');
  if (v) return v;
  if (/not found/i.test(del.description || '')) return 'gone'; // чат уже сам прибрав пост
  // «message can't be deleted» — пост старший за 48 годин: прибираємо з нього телефон і пишемо, що поїздка минула
  const ed = await tgCall('editMessageText', { chat_id: TG_CHAT, message_id: r.tgMessageId, text: rideGoneText(r), parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
  return verdict(ed, 'edited') || 'gone';
}
function sweepDue(now) {
  now = now === undefined ? Date.now() : now;
  return !sweep.busy && now >= sweep.next; // щохвилини; після збою Telegram — через 10 хвилин
}
function sweepPastRides() {
  if (sweep.busy) return sweep.busy;
  sweep.busy = (async () => {
    const now = Date.now(), today = kyivToday(now), giveUp = dayShift(today, -2);
    let later = false, removed = 0, posts = 0;
    try {
      const all = await Ride.find({}).select('type from to date time tgMessageId createdAt').lean();
      for (const r of all.filter(x => rideIsPast(x, now))) {
        if (r.tgMessageId && TG_TOKEN) {
          const res = await tgExpireRide(r);
          await pause(300); // не поспішаємо: Telegram обмежує частоту запитів
          if (res === 'wait') { later = true; break; }
          if (res === 'retry') {
            // Ще спробуємо; але поїздку, що минула понад 2 дні тому, з бази прибираємо все одно (чат сам видалить пост)
            if (/^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) && r.date >= giveUp) { later = true; continue; }
            console.warn('Минулі поїздки: пост ' + r.tgMessageId + ' не вдалося прибрати з чату — здаємося');
          }
          if (res === 'deleted' || res === 'edited') posts++;
        }
        await Ride.deleteOne({ _id: r._id });
        removed++;
      }
      if (removed || later) console.log(`Минулі поїздки (${new Date(kyivWall(now)).toISOString().slice(0, 16).replace('T', ' ')} за Києвом): прибрано ${removed}, постів у чаті ${posts}` + (later ? ', решту — пізніше' : ''));
    } catch (e) {
      console.error('Минулі поїздки:', e.message);
      later = true;
    } finally {
      // Наступне прибирання — за хвилину від початку цього (таймер нижче), після збою Telegram — за 10 хвилин
      sweep.next = now + (later ? SWEEP_RETRY : SWEEP_EVERY - 5000);
      sweep.busy = null;
    }
  })();
  return sweep.busy;
}
// Щохвилини: чи не минула ще якась поїздка (або час повторити невдалу спробу)
const sweepTimer = setInterval(() => { if (sweepDue()) sweepPastRides(); }, SWEEP_EVERY);
if (sweepTimer.unref) sweepTimer.unref();

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
      const rides = await Ride.find({ date: { $gte: dayShift(kyivToday(), -1) } }).select('ownerUid phone tgMessageId').lean();
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

// API для отримання поїздок: лише ті, що ще не минули (година після часу поїздки за Києвом), без поїздок заблокованих
app.get('/api/rides', async (req, res) => {
  try {
    if (!bans.at) await Promise.race([refreshBans(), new Promise(r => setTimeout(r, 3000))]); // щойно запустились
    else if (Date.now() - bans.at > BANS_TTL) refreshBans(); // у фоні
    if (sweepDue()) sweepPastRides(); // прибрати минулі поїздки з бази й чату (у фоні)
    const now = Date.now();
    // Від учорашнього дня: поїздка «вчора о 23:30» видна ще до 00:30
    const rides = await Ride.find({ date: { $gte: dayShift(kyivToday(now), -1) } }).sort({ date: 1, time: 1 });
    res.json(rides.filter(r => !isBanned(r) && !rideIsPast(r, now)).map(publicRide));
  } catch (error) {
    serverError(res, 'GET /api/rides', error);
  }
});

// API для додавання поїздки. З кабінету (є вхід) — поїздка запам'ятовує свого власника.
app.post('/api/rides', async (req, res) => {
  try {
    const uid = await getUid(req);
    if (uid === undefined) return res.status(401).json({ error: 'Вхід застарів. Увійдіть ще раз.' });
    const ip = clientIp(req);
    const { ride: body, error: bad } = cleanRide(req.body);
    if (bad) return res.status(400).json({ error: bad });
    if (uid) body.ownerUid = uid;
    if ((uid && bans.uids.has(uid)) || bans.phones.has(phone9(body.phone))) {
      return res.status(403).json({ error: 'Подавати поїздки з цього акаунта або номера заборонено. Якщо це помилка — напишіть @vilnohirsk.' });
    }
    if (!postAllowed(ip)) {
      console.warn('Попутки: забагато поїздок з однієї адреси або загалом — нову не прийнято');
      return res.status(429).json({ error: 'Забагато оголошень за годину. Спробуйте трохи пізніше.' });
    }
    const newRide = new Ride(body);
    await newRide.save();
    res.status(201).json(publicRide(newRide));
    // У фоні: перевірити нового автора (заблокованого не покажемо) і, якщо все гаразд, опублікувати в Telegram-чаті
    (async () => {
      await refreshBans();
      if (bans.busy) await bans.busy;
      if (!isBanned(newRide)) await tgPostRide(newRide, ip);
    })().catch(e => console.error('Публікація поїздки:', e.message));
  } catch (error) {
    serverError(res, 'POST /api/rides', error);
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
    serverError(res, 'GET /api/my-rides', error);
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
    serverError(res, 'DELETE /api/rides', error);
  }
});

// === Бот техпідтримки сайту (@Vilnogirsk_bot): миттєві кнопки модерації й відповіді ===
// Telegram надсилає оновлення бота сюди (webhook), а сервер одразу передає їх в Apps Script сайту.
// Напряму в Apps Script Telegram слати не може: той відповідає переадресацією, яку Telegram не приймає.
// Ключ webhook (заголовок X-Telegram-Bot-Api-Secret-Token) знає й перевіряє лише Apps Script — тут він не зберігається.
// Вмикається в Apps Script функцією SUPPORT_WEBHOOK_ON, вимикається — SUPPORT_WEBHOOK_OFF.
const tgRelayHits = [];
app.post('/tg/support', async (req, res) => {
  const token = String(req.get('X-Telegram-Bot-Api-Secret-Token') || '');
  const update = req.body;
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(token) || !update || typeof update !== 'object' || !update.update_id) {
    return res.status(403).json({ ok: false });
  }
  // Не більше 60 оновлень на хвилину: решту Telegram надішле згодом сам
  const now = Date.now();
  while (tgRelayHits.length && now - tgRelayHits[0] > 60000) tgRelayHits.shift();
  if (tgRelayHits.length >= 60) return res.status(429).json({ ok: false });
  tgRelayHits.push(now);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(APP_SCRIPT_URL, {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ formType: 'support', action: 'tg', token, update }), signal: ctrl.signal
    });
    const d = await r.json().catch(() => null);
    if (d && d.status === 'ok') return res.json({ ok: true });
    console.error('Бот техпідтримки: Apps Script не прийняв оновлення —', d && d.status || r.status);
    return res.status(d && d.status === 'forbidden' ? 403 : 502).json({ ok: false }); // Telegram повторить пізніше
  } catch (e) {
    console.error('Бот техпідтримки: Apps Script недоступний —', e.message);
    return res.status(502).json({ ok: false });
  } finally {
    clearTimeout(timer);
  }
});

// Невідома адреса й зіпсований запит (наприклад, неправильний JSON) — коротка відповідь без подробиць
app.use((req, res) => res.status(404).json({ error: 'Не знайдено' }));
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) console.error('Запит:', err && err.message || err);
  res.status(status).json({ error: status === 413 ? 'Задовгий запит' : status === 500 ? 'Помилка сервера' : 'Неправильний запит' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server on port ${PORT}`);
});
