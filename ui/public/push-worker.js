self.addEventListener("push", (event) => {
  if (!event.data || event.data.text().length > 4096) return
  const notification = getPushNotification(event.data)
  if (!notification) return
  const url = getConversationUrl(notification.url)
  if (!url || typeof notification.body !== "string" || notification.body.length > 500) return

  event.waitUntil(
    showPushOnce(notification, {
      body: notification.body,
      tag: `touri-${notification.id}`,
      renotify: false,
      icon: "/pwa-192.png",
      data: { url: url.href },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = getConversationUrl(event.notification.data?.url)
  if (!url) return

  event.waitUntil(openConversation(url))
})

const getConversationUrl = (value) => {
  if (typeof value !== "string") return null
  try {
    const url = new URL(value, self.location.origin)
    if (url.origin !== self.location.origin || url.pathname !== "/") return null

    return url
  } catch {
    return null
  }
}

const getPushNotification = (data) => {
  try {
    const notification = data.json()
    if (!notification || typeof notification !== "object") return null
    if (notification.id !== "test" && (!Number.isSafeInteger(notification.id) || notification.id <= 0)) return null

    return notification
  } catch {
    return null
  }
}

const showPushOnce = async (notification, options) => {
  if (notification.id === "test" || typeof indexedDB === "undefined")
    return self.registration.showNotification("touri", options)
  const database = await openSeenDatabase()
  const fresh = await claimNotification(database, notification.id)
  database.close()
  if (!fresh) return

  return self.registration.showNotification("touri", options)
}

const openSeenDatabase = () =>
  new Promise((resolve, reject) => {
    const request = indexedDB.open("touri.push.seen.v1", 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("seen", { keyPath: "id" })
      store.createIndex("expiresAt", "expiresAt")
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })

const claimNotification = (database, id) =>
  new Promise((resolve, reject) => {
    const transaction = database.transaction("seen", "readwrite")
    const store = transaction.objectStore("seen")
    const request = store.get(id)
    const now = Date.now()
    const claimed = { fresh: false }
    request.onsuccess = () => {
      if (request.result?.expiresAt > now) return
      store.put({ id, expiresAt: now + 24 * 60 * 60_000 })
      // The record is committed with the display claim so overlapping push events cannot repeat it.
      claimed.fresh = true
    }
    const expired = store.index("expiresAt").openCursor(IDBKeyRange.upperBound(now))
    const pruned = { count: 0 }
    expired.onsuccess = () => {
      const cursor = expired.result
      if (!cursor || pruned.count >= 100) return
      if (cursor.primaryKey !== id) cursor.delete()
      pruned.count += 1
      cursor.continue()
    }
    transaction.oncomplete = () => resolve(claimed.fresh)
    transaction.onabort = () => reject(transaction.error)
    transaction.onerror = () => reject(transaction.error)
  })

const openConversation = async (url) => {
  const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
  const existing = windows.find((client) => new URL(client.url).origin === url.origin)
  if (!existing) return self.clients.openWindow(url.href)
  const navigated = await existing.navigate(url.href)

  return navigated?.focus()
}
