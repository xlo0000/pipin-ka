const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server);

// Подключение к базе данных
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Инициализация таблиц
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS rooms (
        id VARCHAR(255) PRIMARY KEY,
        video_id VARCHAR(255),
        playing BOOLEAN DEFAULT false,
        time FLOAT DEFAULT 0,
        queue JSONB DEFAULT '[]'::jsonb,
        chat JSONB DEFAULT '[]'::jsonb
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        avatar TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_rooms (
        user_id INTEGER REFERENCES users(id),
        room_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, room_id)
      );
    `);

    console.log('База данных готова!');
  } catch (err) {
    console.error('Ошибка при инициализации БД:', err);
  }
}
initDB();

const roomsCache = {};

// ==========================================
// API ДЛЯ АККАУНТОВ И КОМНАТ
// ==========================================

// 1. Регистрация
app.post('/api/register', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ error: 'Заполните все поля' });

  try {
    const userExists = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (userExists.rows.length > 0) return res.status(400).json({ error: 'Этот email уже занят' });

    const salt = crypto.randomBytes(16).toString('hex');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');
    const passwordHash = `${salt}:${hash}`;

    const newUser = await pool.query(
      'INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email, name, avatar',
      [email, passwordHash, name]
    );

    res.json({ success: true, user: newUser.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 2. Вход
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Заполните все поля' });

  try {
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) return res.status(400).json({ error: 'Неверный email или пароль' });

    const user = result.rows[0];
    const [salt, originalHash] = user.password_hash.split(':');
    const hash = crypto.pbkdf2Sync(password, salt, 1000, 64, 'sha512').toString('hex');

    if (hash !== originalHash) return res.status(400).json({ error: 'Неверный email или пароль' });

    delete user.password_hash;
    res.json({ success: true, user });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 3. Получить комнаты пользователя
app.get('/api/my-rooms/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT room_id FROM user_rooms WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows.map(r => r.room_id));
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 4. Привязать комнату к пользователю
app.post('/api/link-room', async (req, res) => {
  const { userId, roomId } = req.body;
  try {
    await pool.query('INSERT INTO user_rooms (user_id, room_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, roomId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// 5. Удалить комнату из списка пользователя
app.post('/api/delete-room', async (req, res) => {
  const { userId, roomId } = req.body;
  try {
    await pool.query('DELETE FROM user_rooms WHERE user_id = $1 AND room_id = $2', [userId, roomId]);
    res.json({ success: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});


// ==========================================
// ЛОГИКА SOCKET.IO (ВИДЕО, ЧАТ, ЗРИТЕЛИ)
// ==========================================

io.on('connection', (socket) => {
  socket.on('join', async (data) => {
    const roomId = data.room;
    socket.join(roomId);
    
    if (!roomsCache[roomId]) {
      try {
        const res = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
        if (res.rows.length > 0) {
          roomsCache[roomId] = res.rows[0];
          roomsCache[roomId].viewers = [];
        } else {
          await pool.query('INSERT INTO rooms (id) VALUES ($1)', [roomId]);
          roomsCache[roomId] = { id: roomId, video_id: null, playing: false, time: 0, queue: [], chat: [], viewers: [] };
        }
      } catch (err) { console.error(err); }
    }

    let existing = roomsCache[roomId].viewers.find(v => v.id === socket.id);
    if (!existing) {
      roomsCache[roomId].viewers.push({ id: socket.id, name: data.name, avatar: data.avatar || '' });
    } else {
      existing.name = data.name;
      existing.avatar = data.avatar || '';
    }
    
    socket.emit('room-state', {
      videoId: roomsCache[roomId].video_id,
      playing: roomsCache[roomId].playing,
      time: roomsCache[roomId].time,
      queue: roomsCache[roomId].queue || [],
      chat: roomsCache[roomId].chat || [],
      viewers: roomsCache[roomId].viewers
    });
    
    io.to(roomId).emit('viewers-update', roomsCache[roomId].viewers);
  });

  socket.on('update-profile', (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      const viewer = roomsCache[roomId].viewers.find(v => v.id === socket.id);
      if (viewer) { viewer.name = data.name; viewer.avatar = data.avatar; }
      io.to(roomId).emit('viewers-update', roomsCache[roomId].viewers);
    }
  });

  socket.on('play-now', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      roomsCache[roomId].video_id = data.videoId;
      roomsCache[roomId].playing = true;
      roomsCache[roomId].time = 0;
      io.to(roomId).emit('video-action', { videoId: data.videoId, playing: true, time: 0 });
      await saveRoomToDB(roomId);
    }
  });

  socket.on('add-to-queue', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      if (!roomsCache[roomId].queue) roomsCache[roomId].queue = [];
      roomsCache[roomId].queue.push({ videoId: data.videoId, title: data.title, author: data.author, authorId: data.authorId });
      if (!roomsCache[roomId].video_id) {
        const next = roomsCache[roomId].queue.shift();
        roomsCache[roomId].video_id = next.videoId;
        roomsCache[roomId].playing = true;
        roomsCache[roomId].time = 0;
        io.to(roomId).emit('video-action', { videoId: next.videoId, playing: true, time: 0 });
      }
      io.to(roomId).emit('queue-update', roomsCache[roomId].queue);
      await saveRoomToDB(roomId);
    }
  });

  socket.on('remove-from-queue', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      roomsCache[roomId].queue.splice(data.index, 1);
      io.to(roomId).emit('queue-update', roomsCache[roomId].queue);
      await saveRoomToDB(roomId);
    }
  });

  socket.on('play-next', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      if (roomsCache[roomId].queue.length > 0) {
        const next = roomsCache[roomId].queue.shift();
        roomsCache[roomId].video_id = next.videoId;
        roomsCache[roomId].playing = true;
        roomsCache[roomId].time = 0;
        io.to(roomId).emit('queue-update', roomsCache[roomId].queue);
        io.to(roomId).emit('video-action', { videoId: next.videoId, playing: true, time: 0 });
      } else {
        roomsCache[roomId].playing = false;
        roomsCache[roomId].video_id = null;
        io.to(roomId).emit('video-action', { videoId: null, playing: false, time: 0 });
        io.to(roomId).emit('queue-update', []);
      }
      await saveRoomToDB(roomId);
    }
  });

  socket.on('video-ended', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId] && roomsCache[roomId].playing) {
      roomsCache[roomId].playing = false;
      if (roomsCache[roomId].queue.length > 0) {
        const next = roomsCache[roomId].queue.shift();
        roomsCache[roomId].video_id = next.videoId;
        roomsCache[roomId].playing = true;
        roomsCache[roomId].time = 0;
        io.to(roomId).emit('queue-update', roomsCache[roomId].queue);
        io.to(roomId).emit('video-action', { videoId: next.videoId, playing: true, time: 0 });
      } else {
        roomsCache[roomId].video_id = null;
        io.to(roomId).emit('video-action', { videoId: null, playing: false, time: 0 });
      }
      await saveRoomToDB(roomId);
    }
  });

  socket.on('video-action', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      roomsCache[roomId].playing = data.playing;
      roomsCache[roomId].time = data.time;
      if (data.videoId) roomsCache[roomId].video_id = data.videoId;
      socket.to(roomId).emit('video-action', data);
      if (!roomsCache[roomId].lastSave || Date.now() - roomsCache[roomId].lastSave > 5000) {
        roomsCache[roomId].lastSave = Date.now();
        await saveRoomToDB(roomId);
      }
    }
  });

  socket.on('chat-message', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      if (!roomsCache[roomId].chat) roomsCache[roomId].chat = [];
      roomsCache[roomId].chat.push({ name: data.name, text: data.text, avatar: data.avatar });
      if (roomsCache[roomId].chat.length > 100) roomsCache[roomId].chat.shift();
      io.to(roomId).emit('chat-message', data);
      await saveRoomToDB(roomId);
    }
  });

  socket.on('disconnecting', () => {
    for (const roomId of socket.rooms) {
      if (roomsCache[roomId]) {
        roomsCache[roomId].viewers = roomsCache[roomId].viewers.filter(v => v.id !== socket.id);
        io.to(roomId).emit('viewers-update', roomsCache[roomId].viewers);
      }
    }
  });
});

async function saveRoomToDB(roomId) {
  const room = roomsCache[roomId];
  if (!room) return;
  try {
    await pool.query(
      'UPDATE rooms SET video_id = $1, playing = $2, time = $3, queue = $4, chat = $5 WHERE id = $6',
      [room.video_id, room.playing, room.time, JSON.stringify(room.queue || []), JSON.stringify(room.chat || []), roomId]
    );
  } catch (err) { console.error('Ошибка сохранения в БД:', err); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
