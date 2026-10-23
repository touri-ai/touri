import type { Database } from "bun:sqlite"

export type PushDevice = { device_id: string; locale: "pt-BR" | "en"; created_at: number }
export type PushDelivery = { notification_id: number; device_id: string; attempts: number; expires_at: number }

export const createPushStore = (db: Database, now = Date.now) => ({
  getDevice: (deviceId: string) =>
    db.query("SELECT * FROM push_devices WHERE device_id = ?").get(deviceId) as PushDevice | null,
  getDevices: () => db.query("SELECT * FROM push_devices ORDER BY device_id LIMIT 32").all() as PushDevice[],
  saveDevice: (deviceId: string, locale: PushDevice["locale"]) => {
    db.query(`INSERT INTO push_devices(device_id, locale, created_at) VALUES (?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET locale = excluded.locale, created_at = excluded.created_at`).run(
      deviceId,
      locale,
      now(),
    )
  },
  deleteDevice: (deviceId: string) => {
    db.query("DELETE FROM push_devices WHERE device_id = ?").run(deviceId)
  },
  enqueue: (notificationId: number, deviceId: string) => {
    db.query(`INSERT OR IGNORE INTO push_deliveries(notification_id, device_id, next_attempt_at, expires_at)
      VALUES (?, ?, ?, ?)`).run(notificationId, deviceId, now(), now() + 24 * 60 * 60_000)
  },
  getDue: () =>
    db
      .query(`SELECT notification_id, device_id, attempts, expires_at FROM push_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY next_attempt_at LIMIT 2`)
      .all(now()) as PushDelivery[],
  finish: (delivery: PushDelivery) => {
    db.query("UPDATE push_deliveries SET status = 'sent' WHERE notification_id = ? AND device_id = ?").run(
      delivery.notification_id,
      delivery.device_id,
    )
  },
  retry: (delivery: PushDelivery) => {
    const delay = Math.min(300_000, 5_000 * 2 ** Math.min(delivery.attempts, 6))
    db.query(`UPDATE push_deliveries SET attempts = attempts + 1, next_attempt_at = ?
      WHERE notification_id = ? AND device_id = ?`).run(now() + delay, delivery.notification_id, delivery.device_id)
  },
  prune: () => {
    db.query(`DELETE FROM push_deliveries WHERE rowid IN
      (SELECT rowid FROM push_deliveries WHERE expires_at <= ? ORDER BY expires_at LIMIT 100)`).run(now())
  },
})

export type PushStore = ReturnType<typeof createPushStore>
