// 설치(앱으로 추가)를 위한 최소 서비스워커. 캐시하지 않고 항상 최신 콘티를 받아옵니다.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
