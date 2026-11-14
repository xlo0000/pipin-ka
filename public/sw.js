self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

// Простая заглушка для перехвата запросов (можно расширить для оффлайн-режима)
self.addEventListener('fetch', (e) => {
  // Пока просто пропускаем все запросы в сеть
  e.respondWith(fetch(e.request).catch(() => {
    return new Response('Вы оффлайн. Проверьте интернет.');
  }));
});
