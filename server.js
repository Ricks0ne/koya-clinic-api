require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup
const db = new Database('clinic.db');
db.pragma('journal_mode = WAL');

// Schema Migration
db.exec(`
  CREATE TABLE IF NOT EXISTS slots (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    start TEXT NOT NULL,
    end TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id TEXT PRIMARY KEY,
    slot_id TEXT NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('confirmed', 'cancelled')),
    created_at TEXT NOT NULL,
    FOREIGN KEY (slot_id) REFERENCES slots(id)
  );

  CREATE TABLE IF NOT EXISTS idempotency_keys (
    key TEXT PRIMARY KEY,
    request_hash TEXT NOT NULL,
    status_code INTEGER NOT NULL,
    response_body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rate_limits (
    email TEXT NOT NULL,
    timestamp INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_bookings_email ON bookings(email);
  CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings(slot_id, status);
  CREATE INDEX IF NOT EXISTS idx_rate_limits_email ON rate_limits(email, timestamp);
`);

const EXPECTED_API_KEY = process.env.API_KEY || 'koya_assessment_secret_key_2026';

const requireApiKey = (req, res, next) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey || apiKey !== EXPECTED_API_KEY) {
    return res.status(401).json({ error: 'unauthorized or invalid API key' });
  }
  next();
};

const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// POST /reset (Level 1)
app.post('/reset', requireApiKey, (req, res) => {
  try {
    const { slots } = req.body;
    if (!Array.isArray(slots)) {
      return res.status(400).json({ error: 'slots must be an array' });
    }

    const resetTx = db.transaction((slotList) => {
      db.prepare('DELETE FROM bookings').run();
      db.prepare('DELETE FROM slots').run();
      db.prepare('DELETE FROM idempotency_keys').run();
      db.prepare('DELETE FROM rate_limits').run();

      const insertSlot = db.prepare(
        'INSERT INTO slots (id, provider, start, end) VALUES (?, ?, ?, ?)'
      );
      for (const slot of slotList) {
        insertSlot.run(slot.id, slot.provider, slot.start, slot.end);
      }
    });

    resetTx(slots);
    return res.status(200).json({ message: 'Done' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /slots (Level 1)
app.get('/slots', requireApiKey, (req, res) => {
  try {
    const { provider } = req.query;

    let query = `
      SELECT 
        s.id, s.provider, s.start, s.end,
        CASE 
          WHEN b.id IS NOT NULL THEN 0 
          ELSE 1 
        END as available
      FROM slots s
      LEFT JOIN bookings b ON s.id = b.slot_id AND b.status = 'confirmed'
    `;
    const params = [];

    if (provider) {
      query += ' WHERE s.provider = ?';
      params.push(provider);
    }

    query += ' ORDER BY datetime(s.start) ASC';

    const rows = db.prepare(query).all(...params);
    const formattedSlots = rows.map((r) => ({
      id: r.id,
      provider: r.provider,
      start: r.start,
      end: r.end,
      available: Boolean(r.available)
    }));

    return res.status(200).json({ slots: formattedSlots });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /bookings (Levels 1-5)
app.post('/bookings', requireApiKey, (req, res) => {
  try {
    const idempotencyKey = req.headers['idempotency-key'];
    const nowMs = Date.now();
    const oneMinuteAgo = nowMs - 60000;

    if (idempotencyKey) {
      const existing = db.prepare('SELECT * FROM idempotency_keys WHERE key = ?').get(idempotencyKey);
      if (existing) {
        const incomingHash = JSON.stringify(req.body);
        if (existing.request_hash !== incomingHash) {
          return res.status(422).json({ error: 'Idempotency-Key reused with a different body' });
        }
        return res.status(existing.status_code).json(JSON.parse(existing.response_body));
      }
    }

    let { slot_id, name, email } = req.body;

    if (!slot_id || !name || !email) {
      return res.status(400).json({ error: 'slot_id, name, and email are required' });
    }

    name = String(name).trim();
    email = String(email).trim().toLowerCase();

    if (name.length === 0 || email.length === 0 || !emailRegex.test(email)) {
      return res.status(400).json({ error: 'Invalid name or email format' });
    }

    db.prepare('DELETE FROM rate_limits WHERE timestamp < ?').run(oneMinuteAgo);
    
    const recentAttempts = db.prepare(
      'SELECT timestamp FROM rate_limits WHERE email = ? ORDER BY timestamp ASC'
    ).all(email);

    if (recentAttempts.length >= 5) {
      const oldestTimestamp = recentAttempts[0].timestamp;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldestTimestamp + 60000 - nowMs) / 1000));
      res.setHeader('Retry-After', retryAfterSeconds);
      return res.status(429).json({ error: 'Too many attempts for this email' });
    }

    db.prepare('INSERT INTO rate_limits (email, timestamp) VALUES (?, ?)').run(email, nowMs);

    const bookTx = db.transaction(() => {
      const slot = db.prepare('SELECT * FROM slots WHERE id = ?').get(slot_id);
      if (!slot) {
        return { status: 404, data: { error: 'The slot does not exist' } };
      }

      if (new Date(slot.start).getTime() <= nowMs) {
        return { status: 400, data: { error: 'The slot has already started' } };
      }

      const existingBooking = db.prepare(
        "SELECT id FROM bookings WHERE slot_id = ? AND status = 'confirmed'"
      ).get(slot_id);

      if (existingBooking) {
        return { status: 409, data: { error: 'Slot already booked' } };
      }

      const bookingId = uuidv4();
      const createdAt = new Date().toISOString();

      db.prepare(`
        INSERT INTO bookings (id, slot_id, name, email, status, created_at)
        VALUES (?, ?, ?, ?, 'confirmed', ?)
      `).run(bookingId, slot_id, name, email, createdAt);

      const newBooking = {
        id: bookingId,
        slot_id,
        name,
        email,
        status: 'confirmed',
        created_at: createdAt
      };

      return { status: 201, data: newBooking };
    });

    const result = bookTx();

    if (idempotencyKey) {
      db.prepare(`
        INSERT INTO idempotency_keys (key, request_hash, status_code, response_body, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        idempotencyKey,
        JSON.stringify(req.body),
        result.status,
        JSON.stringify(result.data),
        nowMs
      );
    }

    return res.status(result.status).json(result.data);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message });
  }
});

// GET /bookings (Level 4)
app.get('/bookings', requireApiKey, (req, res) => {
  try {
    let { email, limit = 10, cursor } = req.query;

    if (!email) {
      return res.status(400).json({ error: 'email query param is required' });
    }

    limit = Number(limit);
    if (isNaN(limit) || !Number.isInteger(limit) || limit < 1 || limit > 50) {
      return res.status(400).json({ error: 'limit must be an integer between 1 and 50' });
    }

    email = String(email).trim().toLowerCase();

    let query = 'SELECT * FROM bookings WHERE email = ?';
    const params = [email];

    if (cursor) {
      try {
        const decoded = Buffer.from(cursor, 'base64').toString('ascii');
        const [cursorTime, cursorId] = decoded.split(':::');
        query += ' AND (datetime(created_at) > datetime(?) OR (datetime(created_at) = datetime(?) AND id > ?))';
        params.push(cursorTime, cursorTime, cursorId);
      } catch (e) {
        return res.status(400).json({ error: 'Invalid cursor' });
      }
    }

    query += ' ORDER BY datetime(created_at) ASC, id ASC LIMIT ?';
    params.push(limit + 1);

    const items = db.prepare(query).all(...params);

    let next_cursor = null;
    if (items.length > limit) {
      const nextItem = items.pop();
      const lastIncluded = items[items.length - 1];
      next_cursor = Buffer.from(`${lastIncluded.created_at}:::${lastIncluded.id}`).toString('base64');
    }

    return res.status(200).json({
      bookings: items,
      next_cursor
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /bookings/:id (Level 1)
app.get('/bookings/:id', requireApiKey, (req, res) => {
  try {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: 'No booking with that id' });
    }
    return res.status(200).json(booking);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// DELETE /bookings/:id (Level 3)
app.delete('/bookings/:id', requireApiKey, (req, res) => {
  try {
    const booking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);
    if (!booking) {
      return res.status(404).json({ error: 'No booking with that id' });
    }

    if (booking.status === 'cancelled') {
      return res.status(409).json({ error: 'Already cancelled' });
    }

    db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(req.params.id);
    const updatedBooking = db.prepare('SELECT * FROM bookings WHERE id = ?').get(req.params.id);

    return res.status(200).json(updatedBooking);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Clinic API operational on port ${PORT}`);
});