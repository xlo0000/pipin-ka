const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

io.on('connection', (socket) => {
  socket.on('join', (data) => {
    const room = data.room;
    socket.join(room);
    
    if (!rooms[room]) {
      rooms[room] = { videoId: null, playing: false, time: 0, chat: [], viewers: [], queue: [] };
    }

    let existing = rooms[room].viewers.find(v => v.id === socket.id);
    if (!existing) {
      rooms[room].viewers.push({ id: socket.id, name: data.name, avatar: data.avatar || '' });
    } else {
      existing.name = data.name;
      existing.avatar = data.avatar || '';
    }
    
    socket.emit('room-state', rooms[room]);
    io.to(room).emit('viewers-update', rooms[room].viewers);
  });

  socket.on('update-profile', (data) => {
    const room = data.room;
    if (rooms[room]) {
      const viewer = rooms[room].viewers.find(v => v.id === socket.id);
      if (viewer) {
        viewer.name = data.name;
        viewer.avatar = data.avatar;
      }
      io.to(room).emit('viewers-update', rooms[room].viewers);
    }
  });

  // Прямой запуск видео
  socket.on('play-now', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].videoId = data.videoId;
      rooms[room].playing = true;
      rooms[room].time = 0;
      
      io.to(room).emit('video-action', { videoId: data.videoId, playing: true, time: 0 });
    }
  });

  // Добавление в очередь
  socket.on('add-to-queue', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].queue.push({ videoId: data.videoId, title: data.title, author: data.author, authorId: data.authorId });
      
      // Если сейчас ничего не играет, включаем сразу
      if (!rooms[room].videoId) {
        const next = rooms[room].queue.shift();
        rooms[room].videoId = next.videoId;
        rooms[room].playing = true;
        rooms[room].time = 0;
        io.to(room).emit('video-action', { videoId: next.videoId, playing: true, time: 0 });
      }
      
      io.to(room).emit('queue-update', rooms[room].queue);
    }
  });

  // Удаление из очереди
  socket.on('remove-from-queue', (data) => {
    const room = data.room;
    if (rooms[room]) {
      rooms[room].queue.splice(data.index, 1);
      io.to(room).emit('queue-update', rooms[room].queue);
    }
  });

  // Переключить на следующее (вручную или по окончании)
  socket.on('play-next', (data) => {
    const room = data.room;
    if (rooms[room]) {
      if (rooms[room].queue.length > 0) {
        const next = rooms[room].queue.shift();
        rooms[room].videoId = next.videoId;
        rooms[room].playing = true;
        rooms[room].time = 0;
        
        io.to(room).emit('queue-update', rooms[room].queue);
        io.to(room
