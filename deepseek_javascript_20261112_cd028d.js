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
      rooms[room] = { videoId: null, playing: false, time: 0, chat: [] };
    }

    // Отправляем новому участнику текущее состояние комнаты
    socket.emit('room-state', rooms[room]);
    
    // Сообщаем всем, что кто-то зашел
    io.to(room).emit('user-joined', data.name);
  });

  socket.on('video-action', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].playing = data.playing;
      rooms[room].time = data.time;
      if (data.videoId) rooms[room].videoId = data.videoId;
      // Пересылаем действие всем остальным
      socket.to(room).emit('video-action', data);
    }
  });

  socket.on('chat-message', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].chat.push(data);
      // Пересылаем сообщение всем в комнате
      io.to(room).emit('chat-message', data);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));