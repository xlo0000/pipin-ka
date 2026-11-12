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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ==========================================
// ИНИЦИАЛИЗАЦИЯ БАЗЫ ДАННЫХ
// ==========================================
async function initDB() {
  try {
    // Комнаты
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

    // Пользователи
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

    // Комнаты пользователя
    await pool.query(`
      CREATE TABLE IF NOT EXISTS user_rooms (
        user_id INTEGER REFERENCES users(id),
        room_id VARCHAR(255),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, room_id)
      );
    `);

    // Друзья
    await pool.query(`
      CREATE TABLE IF NOT EXISTS friendships (
        id SERIAL PRIMARY KEY,
        user1_id INTEGER REFERENCES users(id),
        user2_id INTEGER REFERENCES users(id),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user1_id, user2_id)
      );
    `);

    // Личные сообщения
    await pool.query(`
      CREATE TABLE IF NOT EXISTS direct_messages (
        id SERIAL PRIMARY KEY,
        sender_id INTEGER REFERENCES users(id),
        receiver_id INTEGER REFERENCES users(id),
        text TEXT NOT NULL,
        reply_to_id INTEGER,
        reactions JSONB DEFAULT '{}'::jsonb,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log('База данных готова (Комнаты + Пользователи + Друзья + Личные сообщения)!');
  } catch (err) { console.error('Ошибка при инициализации БД:', err); }
}
initDB();

const roomsCache = {};

// ==========================================
// API ДЛЯ АККАУНТОВ
// ==========================================
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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

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
  } catch (err) { console.error(err); res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ==========================================
// API ДЛЯ КОМНАТ
// ==========================================
app.get('/api/my-rooms/:userId', async (req, res) => {
  try {
    const result = await pool.query('SELECT room_id FROM user_rooms WHERE user_id = $1 ORDER BY created_at DESC', [req.params.userId]);
    res.json(result.rows.map(r => r.room_id));
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/link-room', async (req, res) => {
  const { userId, roomId } = req.body;
  try {
    await pool.query('INSERT INTO user_rooms (user_id, room_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, roomId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/delete-room', async (req, res) => {
  const { userId, roomId } = req.body;
  try {
    await pool.query('DELETE FROM user_rooms WHERE user_id = $1 AND room_id = $2', [userId, roomId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ==========================================
// API ДЛЯ ДРУЗЕЙ
// ==========================================
app.get('/api/search-users', async (req, res) => {
  const { query, currentUserId } = req.query;
  if (!query) return res.json([]);
  try {
    const result = await pool.query(
      'SELECT id, name, email, avatar FROM users WHERE (name ILIKE $1 OR email ILIKE $1) AND id != $2 LIMIT 10',
      [`%${query}%`, currentUserId]
    );
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/friend-request', async (req, res) => {
  const { senderId, receiverId } = req.body;
  try {
    await pool.query(
      'INSERT INTO friendships (user1_id, user2_id, status) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
      [senderId, receiverId, 'pending']
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/friends/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query(`
      SELECT u.id, u.name, u.email, u.avatar 
      FROM friendships f
      JOIN users u ON (u.id = f.user1_id OR u.id = f.user2_id)
      WHERE (f.user1_id = $1 OR f.user2_id = $1) AND f.status = 'accepted' AND u.id != $1
    `, [userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/friend-requests/:userId', async (req, res) => {
  const userId = req.params.userId;
  try {
    const result = await pool.query(`
      SELECT f.id as request_id, u.id as sender_id, u.name, u.email, u.avatar 
      FROM friendships f
      JOIN users u ON u.id = f.user1_id
      WHERE f.user2_id = $1 AND f.status = 'pending'
    `, [userId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.post('/api/accept-friend', async (req, res) => {
  const { requestId } = req.body;
  try {
    await pool.query('UPDATE friendships SET status = $1 WHERE id = $2', ['accepted', requestId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

app.get('/api/direct-messages', async (req, res) => {
  const { userId, friendId } = req.query;
  try {
    const result = await pool.query(`
      SELECT dm.id, dm.text, dm.created_at, dm.reply_to_id, dm.reactions, u.id as sender_id, u.name as sender_name, u.avatar as sender_avatar
      FROM direct_messages dm
      JOIN users u ON u.id = dm.sender_id
      WHERE (dm.sender_id = $1 AND dm.receiver_id = $2) OR (dm.sender_id = $2 AND dm.receiver_id = $1)
      ORDER BY dm.created_at ASC
    `, [userId, friendId]);
    res.json(result.rows);
  } catch (err) { res.status(500).json({ error: 'Ошибка сервера' }); }
});

// ==========================================
// SOCKET.IO (ВИДЕО, ЧАТ, ЛИЧНЫЕ СООБЩЕНИЯ)
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

  // Чат в комнате (с ответами и смайликами)
  socket.on('chat-message', async (data) => {
    const roomId = data.room;
    if (roomsCache[roomId]) {
      if (!roomsCache[roomId].chat) roomsCache[roomId].chat = [];
      
      // data = { name, text, avatar, replyTo, id }
      const msg = { 
        id: data.id || Date.now().toString(), 
        name: data.name, 
        text: data.text, 
        avatar: data.avatar,
        replyTo: data.replyTo || null,
        reactions: {}
      };
      
      roomsCache[roomId].chat.push(msg);
      if (roomsCache[roomId].chat.length > 100) roomsCache[roomId].chat.shift();
      
      io.to(roomId).emit('chat-message', msg);
      await saveRoomToDB(roomId);
    }
  });

  // Реакции на сообщения в комнате
  socket.on('add-reaction', async (data) => {
    const roomId = data.room;
    const msgId = data.messageId;
    const emoji = data.emoji;
    
    if (roomsCache[roomId]) {
      const msg = roomsCache[roomId].chat.find(m => m.id === msgId);
      if (msg) {
        if (!msg.reactions) msg.reactions = {};
        if (!msg.reactions[emoji]) msg.reactions[emoji] = [];
        
        const userIndex = msg.reactions[emoji].indexOf(data.userName);
        if (userIndex > -1) {
          msg.reactions[emoji].splice(userIndex, 1); // Убираем, если уже есть
        } else {
          msg.reactions[emoji].push(data.userName); // Добавляем
        }
        
        io.to(roomId).emit('update-reactions', { messageId: msgId, reactions: msg.reactions });
        await saveRoomToDB(roomId);
      }
    }
  });

  // Личные сообщения
  socket.on('send-direct-message', async (data) => {
    const { senderId, receiverId, text, replyToId } = data;
    try {
      const result = await pool.query(
        'INSERT INTO direct_messages (sender_id, receiver_id, text, reply_to_id) VALUES ($1, $2, $3, $4) RETURNING id, created_at',
        [senderId, receiverId, text, replyToId]
      );
      
      const newMsg = {
        id: result.rows[0].id,
        sender_id: senderId,
        receiver_id: receiverId,
        text: text,
        reply_to_id: replyToId,
        reactions: {},
        created_at: result.rows[0].created_at
      };

      io.emit('new-direct-message', newMsg); 
    } catch (err) { console.error(err); }
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
