var CACHE_NAME = "pwa-task-manager-v2"; // Increment version to force update
var urlsToCache = ["/", "/completed"];

// Install a service worker
self.addEventListener("install", (event) => {
  console.log("Service Worker: Installing...");
  // Force the waiting service worker to become the active service worker
  self.skipWaiting();

  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then(function (cache) {
        console.log("Service Worker: Opened cache");
        return cache.addAll(urlsToCache);
      })
      .catch((err) => {
        console.log("Service Worker: Cache failed", err);
      }),
  );
});

// Cache and return requests - NETWORK FIRST STRATEGY
self.addEventListener("fetch", (event) => {
  event.respondWith(
    fetch(event.request)
      .then(function (response) {
        // Check if we received a valid response
        if (!response || response.status !== 200 || response.type !== "basic") {
          return response;
        }

        // Clone the response
        var responseToCache = response.clone();

        caches.open(CACHE_NAME).then(function (cache) {
          cache.put(event.request, responseToCache);
        });

        return response;
      })
      .catch(function () {
        // Network failed, try cache
        return caches.match(event.request).then(function (response) {
          if (response) {
            return response;
          }
          // Return a custom offline page or response if needed
          return new Response("Offline - Content not available", {
            status: 503,
            statusText: "Service Unavailable",
            headers: new Headers({
              "Content-Type": "text/plain",
            }),
          });
        });
      }),
  );
});

// Update a service worker
self.addEventListener("activate", (event) => {
  console.log("Service Worker: Activating...");
  var cacheWhitelist = ["pwa-task-manager-v2"]; // Update this with new version

  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) => {
        return Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheWhitelist.indexOf(cacheName) === -1) {
              console.log("Service Worker: Deleting old cache", cacheName);
              return caches.delete(cacheName);
            }
          }),
        );
      })
      .then(() => {
        // Take control of all pages immediately
        return self.clients.claim();
      }),
  );
});
