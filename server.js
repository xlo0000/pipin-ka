const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Временное хранение состояния комнат в памяти
const rooms = {};

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const room = data.room;
    socket.join(room);
    
    if (!rooms[room]) {
      rooms[room] = { videoId: null, playing: false, time: 0, chat: [], viewers: [] };
    }

    // Добавляем зрителя
    rooms[room].viewers.push({ id: socket.id, name: data.name });
    
    // Отправляем новому участнику текущее состояние комнаты
    socket.emit('room-state', rooms[room]);
    
    // Обновляем список зрителей у всех
    io.to(room).emit('viewers-update', rooms[room].viewers);
  });

  // Обновление имени (когда пользователь меняет его в профиле)
  socket.on('update-name', (data) => {
    const room = data.room;
    if (rooms[room]) {
      const viewer = rooms[room].viewers.find(v => v.id === socket.id);
      if (viewer) viewer.name = data.name;
      io.to(room).emit('viewers-update', rooms[room].viewers);
    }
  });

  socket.on('video-action', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].playing = data.playing;
      rooms[room].time = data.time;
      if (data.videoId) rooms[room].videoId = data.videoId;
      socket.to(room).emit('video-action', data);
    }
  });

  socket.on('chat-message', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].chat.push(data);
      io.to(room).emit('chat-message', data);
    }
  });

  // Удаление зрителя, когда он закрывает вкладку
  socket.on('disconnecting', () => {
    for (const room of socket.rooms) {
      if (rooms[room]) {
        rooms[room].viewers = rooms[room].viewers.filter(v => v.id !== socket.id);
        io.to(room).emit('viewers-update', rooms[room].viewers);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
