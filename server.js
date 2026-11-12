const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Подключение к базе данных (берем URL из переменных Render)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Обязательно для Render
});

// При запуске создаем таблицы, если их нет
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
    console.log('База данных готова к работе!');
  } catch (err) {
    console.error('Ошибка при инициализации БД:', err);
  }
}
initDB();

// Временный кэш комнат в памяти, чтобы не дергать базу каждую секунду
const roomsCache = {};

io.on('connection', (socket) => {
  socket.on('join', async (data) => {
    const roomId = data.room;
    socket.join(roomId);
    
    // Если комнаты нет в кэше, ищем в базе
    if (!roomsCache[roomId]) {
      try {
        const res = await pool.query('SELECT * FROM rooms WHERE id = $1', [roomId]);
        if (res.rows.length > 0) {
          roomsCache[roomId] = res.rows[0];
          // Восстанавливаем зрителей (они не хранятся в БД, только активные)
          roomsCache[roomId].viewers = [];
        } else {
          // Если комнаты нет, создаем новую в базе
          await pool.query('INSERT INTO rooms (id) VALUES ($1)', [roomId]);
          roomsCache[roomId] = { id: roomId, video_id: null, playing: false, time: 0, queue: [], chat: [], viewers: [] };
        }
      } catch (err) {
        console.error(err);
      }
    }

    // Добавляем зрителя
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
      if (viewer) {
        viewer.name = data.name;
        viewer.avatar = data.avatar;
      }
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
      
      // Сохраняем состояние в БД (не чаще раза в 5 секунд)
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
      
      // Ограничиваем историю чата последними 100 сообщениями
      if (roomsCache[roomId].chat.length > 100) {
        roomsCache[roomId].chat.shift();
      }
      
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

// Функция сохранения состояния комнаты в БД
async function saveRoomToDB(roomId) {
  const room = roomsCache[roomId];
  if (!room) return;
  try {
    await pool.query(
      'UPDATE rooms SET video_id = $1, playing = $2, time = $3, queue = $4, chat = $5 WHERE id = $6',
      [room.video_id, room.playing, room.time, JSON.stringify(room.queue || []), JSON.stringify(room.chat || []), roomId]
    );
  } catch (err) {
    console.error('Ошибка сохранения в БД:', err);
  }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
