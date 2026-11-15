'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { open, tx } = require('./db');
const sec = require('./security');
const U = require('./util');
const { createMailer } = require('./mailer');
const { createWorker, materializeForElder } = require('./worker');
const { buildDigest } = require('./digest');
const T = require('./templates');
const { HttpError } = U;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
    '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.md': 'text/plain; charset=utf-8' };
const CSP = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

function createApp(opts = {}) {
    const env = { ...process.env, ...(opts.env || {}) };
    const now = opts.now || Date.now;
    const prod = env.NODE_ENV === 'production';
    const db = open(opts.dbFile || env.DB_FILE || path.join(__dirname, '..', 'data', 'elderease.db'));
    const mailer = opts.mailer || createMailer(env);
    const siteDir = path.resolve(opts.siteDir || path.join(__dirname, '..', '..', 'site'));
    const log = opts.log || ((...a) => console.log('[elderease]', ...a));
    const cfg = { appUrl: (env.APP_URL || 'http://localhost:' + (env.PORT || 3000)).replace(/\/$/, ''),
        leadMin: Number(env.DOSE_LEAD_MIN) || 15, graceMin: Number(env.MISSED_GRACE_MIN) || 60,
        dailyHour: env.DIGEST_DAILY_HOUR !== undefined ? Number(env.DIGEST_DAILY_HOUR) : 20, weeklyHour: env.DIGEST_WEEKLY_HOUR !== undefined ? Number(env.DIGEST_WEEKLY_HOUR) : 9 };
    const SESSION_MS = 7 * 864e5;

    /* ---------- live sync (Server-Sent Events) ---------- */
    const streams = new Map();                                   // elderId -> Set<res>
    function publish(elderId, event, data) {
        const set = streams.get(Number(elderId));
        if (!set) return;
        for (const res of set) res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
    }
    const worker = createWorker({ db, mailer, now, cfg, publish, log });

    /* ---------- helpers ---------- */
    const limiters = { api: sec.makeLimiter(600, 60e3, now), register: sec.makeLimiter(10, 3600e3, now), join: sec.makeLimiter(10, 3600e3, now),
        digest: sec.makeLimiter(5, 3600e3, now), invite: sec.makeLimiter(20, 3600e3, now),
        forgotIp: sec.makeLimiter(10, 3600e3, now), forgotEmail: sec.makeLimiter(3, 3600e3, now), reset: sec.makeLimiter(20, 3600e3, now),
        exportU: sec.makeLimiter(10, 3600e3, now), deleteU: sec.makeLimiter(5, 3600e3, now) };
    const RESET_MIN = 30;
    const pwProblem = pw => (pw.length < 8 || pw.length > 128 || !/[A-Za-z]/.test(pw) || !/\d/.test(pw)) ? 'Password must be 8 to 128 characters with a letter and a number.' : null;
    const clearCookie = res => res.setHeader('Set-Cookie', `ee_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${prod ? '; Secure' : ''}`);
    const clientIp = req => (env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || 'unknown';
    const nowIso = () => U.iso(now());

    function sessionUser(req) {
        const m = /(?:^|;\s*)ee_session=([A-Za-z0-9_-]{20,80})/.exec(req.headers.cookie || '');
        if (!m) return null;
        return db.prepare(`SELECT u.id, u.email, u.name, u.role, u.age, u.tz_offset_min, u.email_reminders, u.digest FROM sessions s JOIN users u ON u.id = s.user_id
            WHERE s.token_hash = ? AND s.expires_at > ?`).get(sec.sha256(m[1]), nowIso()) || null;
    }
    function access(user, elderId) {
        const elder = db.prepare("SELECT id, name, tz_offset_min FROM users WHERE id = ? AND role = 'elder'").get(elderId);
        if (!elder) return null;
        if (user.id === elder.id) return { elder, level: 'owner', write: true };
        const l = db.prepare('SELECT role FROM care_links WHERE elder_id = ? AND member_id = ?').get(elder.id, user.id);
        return l ? { elder, level: l.role, write: l.role === 'caretaker' } : null;
    }
    function need(user, id, write) {
        const a = access(user, Number(id));
        if (!a) throw new HttpError(404, 'Not found.');                       // same answer whether it exists or you just can't see it
        if (write && !a.write) throw new HttpError(403, 'You have view-only access to this person.');
        return a;
    }
    const medsFor = elderId => {
        const meds = db.prepare('SELECT id, name, dose, notes, days FROM medications WHERE elder_id = ? AND active = 1 ORDER BY name').all(elderId);
        const t = db.prepare('SELECT hhmm FROM med_times WHERE medication_id = ? ORDER BY hhmm');
        return meds.map(m => ({ ...m, times: t.all(m.id).map(x => x.hhmm) }));
    };
    const dosesFor = (elder, date) => db.prepare(`SELECT d.id, d.medication_id, m.name, m.dose, d.hhmm, d.due_at, d.local_date, d.status, d.acted_at, u.name AS acted_by_name
        FROM dose_events d JOIN medications m ON m.id = d.medication_id LEFT JOIN users u ON u.id = d.acted_by
        WHERE d.elder_id = ? AND d.local_date = ? ORDER BY d.due_at, m.name`).all(elder.id, date);
    const apptsFor = (elder, all) => db.prepare(`SELECT id, title, doctor, location, notes, starts_at FROM appointments WHERE elder_id = ? AND cancelled = 0 AND starts_at >= ? ORDER BY starts_at LIMIT 50`)
        .all(elder.id, U.iso(now() - (all ? 30 * 864e5 : 3600e3))).map(a => ({ ...a, local: U.fmtLocal(Date.parse(a.starts_at), elder.tz_offset_min) }));
    const publicUser = u => ({ id: u.id, name: u.name, email: u.email, role: u.role, age: u.age, email_reminders: !!u.email_reminders, digest: u.digest });

    function parseMed(b, partial) {
        const out = {};
        if (!partial || b.name !== undefined) { out.name = U.clean(b.name, 80); if (!out.name) throw new HttpError(400, 'Give the medicine a name.'); }
        if (!partial || b.dose !== undefined) out.dose = U.clean(b.dose, 60);
        if (!partial || b.notes !== undefined) out.notes = U.clean(b.notes, 200);
        if (!partial || b.days !== undefined) {
            const d = b.days === undefined ? '1111111' : String(b.days);
            if (!/^[01]{7}$/.test(d) || !d.includes('1')) throw new HttpError(400, 'Choose at least one day.');
            out.days = d;
        }
        if (!partial || b.times !== undefined) {
            const t = Array.isArray(b.times) ? [...new Set(b.times.map(String))].sort() : [];
            if (!t.length || t.length > 6 || !t.every(U.isTime)) throw new HttpError(400, 'Add 1 to 6 times like 08:00.');
            out.times = t;
        }
        return out;
    }

    /* ---------- routes ---------- */
    const routes = [];
    const route = (method, pattern, o, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '/?$'), auth: o.auth !== false, csrf: o.csrf !== false, fn });

    route('GET', '/api/health', { auth: false }, () => ({ ok: true, email: mailer.provider, demo: !!db.prepare("SELECT 1 FROM users WHERE email = 'elder.demo@elderease.in'").get() }));

    route('POST', '/api/auth/register', { auth: false }, async ({ req, body }) => {
        if (!limiters.register.hit(clientIp(req))) throw new HttpError(429, 'Too many sign-ups from here. Try again later.');
        const name = U.clean(body.name, 80), email = String(body.email || '').trim().toLowerCase().slice(0, 254), role = body.role, age = Number(body.age), pw = String(body.password || '');
        if (name.length < 2) throw new HttpError(400, 'Please enter your full name.');
        if (!U.EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
        if (!['elder', 'caretaker', 'family'].includes(role)) throw new HttpError(400, 'Please choose who you are.');
        if (!Number.isInteger(age)) throw new HttpError(400, 'Please enter your age as a whole number.');
        if (role === 'elder' && !(age >= 60 && age <= 120)) throw new HttpError(400, 'Elder accounts are for people aged 60 or older.');
        if (role !== 'elder' && !(age >= 18 && age <= 120)) throw new HttpError(400, 'Family members and caretakers must be 18 or older.');
        if (pwProblem(pw)) throw new HttpError(400, pwProblem(pw));
        const hash = await sec.hashPassword(pw);                                  // always hash: same timing for new and existing emails
        if (!db.prepare('SELECT id FROM users WHERE email = ?').get(email)) {
            const r = db.prepare('INSERT INTO users(email, name, role, age, pass_hash, digest, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
                .run(email, name, role, age, hash, role === 'caretaker' ? 'daily' : 'weekly', nowIso());
            if (role !== 'elder' && body.passcode) { try { joinWithCode({ id: Number(r.lastInsertRowid), role }, body.passcode); } catch (e) { /* silent: same reply either way */ } }
        }
        return { ok: true };                                                      // identical reply whether or not the email already existed
    });

    route('POST', '/api/auth/login', { auth: false }, async ({ req, res, body }) => {
        const email = String(body.email || '').trim().toLowerCase().slice(0, 254), pw = String(body.password || '').slice(0, 128);
        const keys = [{ k: 'e:' + email, max: 5 }, { k: 'i:' + clientIp(req), max: 25 }];
        for (const { k } of keys) {
            const r = db.prepare('SELECT locked_until FROM login_attempts WHERE key = ?').get(k);
            if (r && Number(r.locked_until) > now()) throw new HttpError(429, `Too many attempts. Try again in ${Math.ceil((Number(r.locked_until) - now()) / 1000)} seconds.`);
        }
        const user = db.prepare('SELECT id, pass_hash FROM users WHERE email = ?').get(email);
        const ok = await sec.verifyPassword(pw, user ? user.pass_hash : await sec.dummyHash());
        if (!user || !ok) {
            for (const { k, max } of keys) {
                db.prepare('INSERT OR IGNORE INTO login_attempts(key) VALUES (?)').run(k);
                const r = db.prepare('SELECT fails, locks FROM login_attempts WHERE key = ?').get(k);
                const fails = Number(r.fails) + 1;
                if (fails >= max) {
                    const locks = Number(r.locks) + 1;
                    db.prepare('UPDATE login_attempts SET fails = 0, locks = ?, locked_until = ? WHERE key = ?').run(locks, now() + Math.min(60e3 * 2 ** (locks - 1), 30 * 60e3), k);
                } else db.prepare('UPDATE login_attempts SET fails = ? WHERE key = ?').run(fails, k);
            }
            throw new HttpError(401, 'Incorrect email or password.');
        }
        db.prepare('DELETE FROM login_attempts WHERE key = ?').run('e:' + email);
        const token = sec.newToken();
        db.prepare('INSERT INTO sessions(token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sec.sha256(token), user.id, U.iso(now() + SESSION_MS), nowIso());
        res.setHeader('Set-Cookie', `ee_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_MS / 1000}${prod ? '; Secure' : ''}`);
        return { ok: true, user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
    });

    route('POST', '/api/auth/logout', { auth: false }, ({ req, res }) => {
        const m = /(?:^|;\s*)ee_session=([A-Za-z0-9_-]{20,80})/.exec(req.headers.cookie || '');
        if (m) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sec.sha256(m[1]));
        clearCookie(res);
        return { ok: true };
    });

    /* FORGOTTEN PASSWORD
       Always the same reply, whether or not the email has an account, and the email is sent in the background
       so the response time does not give it away either. The link carries the token after "#", so it never
       reaches server logs or Referer headers; only its SHA-256 is stored. */
    route('POST', '/api/auth/forgot', { auth: false }, ({ req, body }) => {
        const email = String(body.email || '').trim().toLowerCase().slice(0, 254);
        if (!limiters.forgotIp.hit(clientIp(req))) throw new HttpError(429, 'Too many reset requests from here. Try again in an hour.');
        const reply = { ok: true, message: 'If that email has an ElderEase account, a reset link is on its way. It expires in 30 minutes.' };
        if (!U.EMAIL_RE.test(email) || !limiters.forgotEmail.hit(email)) return reply;
        const user = db.prepare('SELECT id, name, email FROM users WHERE email = ?').get(email);
        if (!user) return reply;
        const token = sec.newToken();
        tx(db, () => {
            db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(user.id);          // only the newest link works
            db.prepare('INSERT INTO password_resets(user_id, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?)')
                .run(user.id, sec.sha256(token), U.iso(now() + RESET_MIN * 60000), nowIso());
        });
        const link = `${cfg.appUrl}/reset.html#t=${token}`;
        if (mailer.provider === 'dev' && !prod) log(`dev mode, no email provider: reset link for ${email} -> ${link}`);
        const mail = T.passwordReset({ name: user.name, link, minutes: RESET_MIN }, cfg.appUrl);
        const logged = T.passwordReset({ name: user.name, link: `${cfg.appUrl}/reset.html (link removed from this copy)`, minutes: RESET_MIN }, cfg.appUrl);
        worker.sendSecret({ key: `reset:${sec.sha256(token).slice(0, 24)}`, user, kind: 'password_reset', mail, logged })
            .catch(e => log('reset mail failed', e.message));
        return reply;
    });

    route('POST', '/api/auth/reset', { auth: false }, async ({ req, res, body }) => {
        if (!limiters.reset.hit(clientIp(req))) throw new HttpError(429, 'Too many attempts. Try again later.');
        const token = String(body.token || '');
        const pw = String(body.password || '');
        const bad = new HttpError(400, 'This reset link is not valid or has expired. Ask for a new one.');
        if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw bad;
        const row = db.prepare('SELECT r.id, r.user_id, u.email, u.name FROM password_resets r JOIN users u ON u.id = r.user_id WHERE r.token_hash = ? AND r.used_at IS NULL AND r.expires_at > ?')
            .get(sec.sha256(token), nowIso());
        if (!row) throw bad;
        if (pwProblem(pw)) throw new HttpError(400, pwProblem(pw));
        const hash = await sec.hashPassword(pw);
        const used = tx(db, () => {
            // re-check inside the transaction so two tabs cannot both use one link
            const r = db.prepare('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL').run(nowIso(), row.id);
            if (!Number(r.changes)) return false;
            db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(hash, row.user_id);
            db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);              // sign out every device
            db.prepare('DELETE FROM password_resets WHERE user_id = ? AND id != ?').run(row.user_id, row.id);
            db.prepare('DELETE FROM login_attempts WHERE key = ?').run('e:' + row.email);
            return true;
        });
        if (!used) throw bad;
        clearCookie(res);
        worker.queue({ key: `pwchanged:${sec.sha256(token).slice(0, 24)}`, user: { id: row.user_id, email: row.email }, elderId: null, kind: 'password_changed', mail: T.passwordChanged({ name: row.name }, cfg.appUrl) })
            .catch(e => log('notice mail failed', e.message));
        return { ok: true };
    });

    route('GET', '/api/me', {}, ({ user }) => ({ user: publicUser(user) }));
    // same as /api/me but answers 200 with user: null when nobody is signed in (used by pages to check quietly)
    route('GET', '/api/session', { auth: false }, ({ req }) => { const u = sessionUser(req); return { user: u ? publicUser(u) : null }; });
    route('PATCH', '/api/me', {}, ({ user, body }) => {
        if (body.email_reminders !== undefined) db.prepare('UPDATE users SET email_reminders = ? WHERE id = ?').run(body.email_reminders ? 1 : 0, user.id);
        if (body.digest !== undefined) {
            if (!['off', 'daily', 'weekly'].includes(body.digest)) throw new HttpError(400, 'Digest must be off, daily or weekly.');
            db.prepare('UPDATE users SET digest = ? WHERE id = ?').run(body.digest, user.id);
        }
        return { user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) };
    });

    /* YOUR DATA: download everything about you, or delete your account (DPDP Act 2023) */
    route('GET', '/api/me/export', {}, ({ res, user }) => {
        if (!limiters.exportU.hit('u' + user.id)) throw new HttpError(429, 'You can download your data 10 times an hour.');
        const u = db.prepare('SELECT id, email, name, role, age, tz_offset_min, email_reminders, digest, created_at FROM users WHERE id = ?').get(user.id);
        const out = { exported_at: nowIso(), account: u,
            care_links: db.prepare(`SELECT l.role, l.created_at, e.name AS elder_name, m.name AS member_name FROM care_links l
                JOIN users e ON e.id = l.elder_id JOIN users m ON m.id = l.member_id WHERE l.elder_id = ? OR l.member_id = ?`).all(user.id, user.id),
            emails_to_you: db.prepare('SELECT kind, subject, body_text, status, created_at, sent_at FROM email_log WHERE to_user_id = ? ORDER BY id').all(user.id) };
        if (user.role === 'elder') {
            out.medications = medsFor(user.id).concat(
                db.prepare('SELECT id, name, dose, notes, days, created_at FROM medications WHERE elder_id = ? AND active = 0').all(user.id).map(m => ({ ...m, removed: true })));
            out.doses = db.prepare(`SELECT d.local_date, d.hhmm, m.name, m.dose, d.status, d.acted_at, u.name AS acted_by, d.note FROM dose_events d
                JOIN medications m ON m.id = d.medication_id LEFT JOIN users u ON u.id = d.acted_by WHERE d.elder_id = ? ORDER BY d.due_at`).all(user.id);
            out.dose_changes = db.prepare(`SELECT a.at, m.name, d.local_date, d.hhmm, a.old_status, a.new_status, u.name AS by_name FROM dose_audit a
                JOIN dose_events d ON d.id = a.dose_id JOIN medications m ON m.id = d.medication_id LEFT JOIN users u ON u.id = a.by_user WHERE d.elder_id = ? ORDER BY a.id`).all(user.id);
            out.appointments = db.prepare('SELECT title, doctor, location, notes, starts_at, cancelled, created_at FROM appointments WHERE elder_id = ? ORDER BY starts_at').all(user.id);
        }
        res.setHeader('Content-Disposition', `attachment; filename="elderease-data-${U.localParts(now(), user.tz_offset_min).date}.json"`);
        return out;
    });

    route('POST', '/api/me/delete', {}, async ({ res, user, body }) => {
        if (!limiters.deleteU.hit('u' + user.id)) throw new HttpError(429, 'Too many attempts. Try again later.');
        if (body.confirm !== 'DELETE') throw new HttpError(400, 'Type DELETE to confirm.');
        const row = db.prepare('SELECT pass_hash, email FROM users WHERE id = ?').get(user.id);
        if (!(await sec.verifyPassword(String(body.password || '').slice(0, 128), row.pass_hash))) throw new HttpError(403, 'That password is not right.');
        const affected = db.prepare('SELECT elder_id FROM care_links WHERE member_id = ?').all(user.id).map(r => r.elder_id);
        tx(db, () => {
            const id = user.id;
            // keep other people's records intact, but no longer pointing at this person
            for (const sql of ['UPDATE dose_events SET acted_by = NULL WHERE acted_by = ?', 'UPDATE dose_audit SET by_user = NULL WHERE by_user = ?',
                'UPDATE medications SET created_by = NULL WHERE created_by = ?', 'UPDATE appointments SET created_by = NULL WHERE created_by = ?',
                'UPDATE invites SET used_by = NULL WHERE used_by = ?']) db.prepare(sql).run(id);
            db.prepare('DELETE FROM email_log WHERE to_user_id = ? OR elder_id = ?').run(id, id);   // emails to them, and about them
            db.prepare('DELETE FROM login_attempts WHERE key = ?').run('e:' + row.email);
            db.prepare('DELETE FROM users WHERE id = ?').run(id);           // cascades: sessions, links, invites, resets, and for an elder all medicines, doses, appointments
        });
        if (user.role === 'elder') publish(user.id, 'circle', { deleted: true }); else for (const e of affected) publish(e, 'circle', {});
        clearCookie(res);
        return { ok: true };
    });

    /* care circle */
    route('GET', '/api/care/circle', {}, ({ user }) => {
        if (user.role === 'elder') {
            const members = db.prepare(`SELECT l.id AS link_id, u.id, u.name, u.email, l.role FROM care_links l JOIN users u ON u.id = l.member_id WHERE l.elder_id = ? ORDER BY l.created_at`).all(user.id);
            return { elders: [{ id: user.id, name: user.name, level: 'owner', write: true, tz_offset_min: user.tz_offset_min }], members };
        }
        const elders = db.prepare(`SELECT l.id AS link_id, e.id, e.name, l.role AS level, e.tz_offset_min FROM care_links l JOIN users e ON e.id = l.elder_id WHERE l.member_id = ? ORDER BY e.name`).all(user.id)
            .map(e => ({ ...e, write: e.level === 'caretaker' }));
        return { elders, members: [] };
    });
    route('POST', '/api/care/invites', {}, ({ user, body }) => {
        if (user.role !== 'elder') throw new HttpError(403, 'Only the elder can create a care passcode.');
        if (!limiters.invite.hit('u' + user.id)) throw new HttpError(429, 'Too many passcodes. Try again later.');
        const role = body.role;
        if (!['caretaker', 'family'].includes(role)) throw new HttpError(400, 'Choose caretaker or family.');
        db.prepare('DELETE FROM invites WHERE elder_id = ? AND used_by IS NULL AND expires_at < ?').run(user.id, nowIso());
        const code = sec.newInviteCode(), expires = U.iso(now() + 48 * 3600e3);
        db.prepare('INSERT INTO invites(elder_id, code_hash, role, expires_at, created_at) VALUES (?, ?, ?, ?, ?)').run(user.id, sec.sha256(sec.normCode(code)), role, expires, nowIso());
        return { code, role, expires_at: expires };
    });
    function joinWithCode(user, rawCode) {
        const inv = db.prepare('SELECT * FROM invites WHERE code_hash = ? AND used_by IS NULL AND expires_at > ?').get(sec.sha256(sec.normCode(rawCode)), nowIso());
        if (!inv || inv.role !== user.role) throw new HttpError(400, 'That passcode is not valid for your account, or it has expired.');
        tx(db, () => {
            db.prepare('INSERT OR IGNORE INTO care_links(elder_id, member_id, role, created_at) VALUES (?, ?, ?, ?)').run(inv.elder_id, user.id, inv.role, nowIso());
            db.prepare('UPDATE invites SET used_by = ? WHERE id = ?').run(user.id, inv.id);
        });
        publish(inv.elder_id, 'circle', {});
        return inv.elder_id;
    }
    route('POST', '/api/care/join', {}, ({ req, user, body }) => {
        if (user.role === 'elder') throw new HttpError(403, 'Elders share a passcode; they do not enter one.');
        if (!limiters.join.hit('u' + user.id + ':' + clientIp(req))) throw new HttpError(429, 'Too many tries. Please wait a while.');
        const elderId = joinWithCode(user, body.code);
        return { ok: true, elder_id: elderId };
    });
    route('DELETE', '/api/care/links/:id', {}, ({ user, params }) => {
        const l = db.prepare('SELECT * FROM care_links WHERE id = ?').get(Number(params.id));
        if (!l || (l.elder_id !== user.id && l.member_id !== user.id)) throw new HttpError(404, 'Not found.');
        db.prepare('DELETE FROM care_links WHERE id = ?').run(l.id);
        publish(l.elder_id, 'circle', {});
        return { ok: true };
    });

    /* per-elder data */
    route('GET', '/api/elders/:id/overview', {}, ({ user, params }) => {
        const a = need(user, params.id);
        materializeForElder(db, a.elder, now());
        const today = U.localParts(now(), a.elder.tz_offset_min).date;
        const week = buildDigest(db, a.elder, 7, now());
        return { elder: { id: a.elder.id, name: a.elder.name }, level: a.level, write: a.write, today, doses: dosesFor(a.elder, today), week: week.totals, perfectDays: week.perfectDays, appointments: apptsFor(a.elder).slice(0, 3) };
    });
    route('GET', '/api/elders/:id/medications', {}, ({ user, params }) => ({ medications: medsFor(need(user, params.id).elder.id) }));
    route('POST', '/api/elders/:id/medications', {}, ({ user, params, body }) => {
        const a = need(user, params.id, true), m = parseMed(body, false);
        tx(db, () => {
            const r = db.prepare('INSERT INTO medications(elder_id, name, dose, notes, days, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(a.elder.id, m.name, m.dose, m.notes, m.days, user.id, nowIso());
            for (const t of m.times) db.prepare('INSERT INTO med_times(medication_id, hhmm) VALUES (?, ?)').run(Number(r.lastInsertRowid), t);
        });
        materializeForElder(db, a.elder, now());
        publish(a.elder.id, 'meds', {});
        return { medications: medsFor(a.elder.id) };
    });
    function medForWrite(user, id) {
        const m = db.prepare('SELECT * FROM medications WHERE id = ? AND active = 1').get(Number(id));
        if (!m) throw new HttpError(404, 'Not found.');
        return { m, a: need(user, m.elder_id, true) };
    }
    route('PATCH', '/api/medications/:id', {}, ({ user, params, body }) => {
        const { m, a } = medForWrite(user, params.id), p = parseMed(body, true);
        tx(db, () => {
            for (const f of ['name', 'dose', 'notes', 'days']) if (p[f] !== undefined) db.prepare(`UPDATE medications SET ${f} = ? WHERE id = ?`).run(p[f], m.id);
            if (p.times) { db.prepare('DELETE FROM med_times WHERE medication_id = ?').run(m.id); for (const t of p.times) db.prepare('INSERT INTO med_times(medication_id, hhmm) VALUES (?, ?)').run(m.id, t); }
            if (p.times || p.days) db.prepare("DELETE FROM dose_events WHERE medication_id = ? AND status = 'pending' AND due_at > ?").run(m.id, nowIso());
        });
        materializeForElder(db, a.elder, now());
        publish(a.elder.id, 'meds', {});
        return { medications: medsFor(a.elder.id) };
    });
    route('DELETE', '/api/medications/:id', {}, ({ user, params }) => {
        const { m, a } = medForWrite(user, params.id);
        db.prepare('UPDATE medications SET active = 0 WHERE id = ?').run(m.id);       // history stays; only future doses go
        db.prepare("DELETE FROM dose_events WHERE medication_id = ? AND status = 'pending' AND due_at > ?").run(m.id, nowIso());
        publish(a.elder.id, 'meds', {});
        return { medications: medsFor(a.elder.id) };
    });
    route('GET', '/api/elders/:id/doses', {}, ({ user, params, query }) => {
        const a = need(user, params.id);
        const date = U.isDate(query.date) ? query.date : U.localParts(now(), a.elder.tz_offset_min).date;
        return { date, doses: dosesFor(a.elder, date) };
    });
    route('POST', '/api/doses/:id/mark', {}, ({ user, params, body }) => {
        const d = db.prepare('SELECT * FROM dose_events WHERE id = ?').get(Number(params.id));
        if (!d) throw new HttpError(404, 'Not found.');
        const a = need(user, d.elder_id, true);
        if (!['taken', 'skipped'].includes(body.status)) throw new HttpError(400, 'Status must be taken or skipped.');
        if (Date.parse(d.due_at) > now() + 3 * 3600e3) throw new HttpError(400, 'This dose is not due yet.');
        tx(db, () => {
            db.prepare('UPDATE dose_events SET status = ?, acted_at = ?, acted_by = ?, note = ? WHERE id = ?').run(body.status, nowIso(), user.id, U.clean(body.note, 200), d.id);
            db.prepare('INSERT INTO dose_audit(dose_id, old_status, new_status, by_user, at) VALUES (?, ?, ?, ?, ?)').run(d.id, d.status, body.status, user.id, nowIso());
        });
        publish(a.elder.id, 'dose', { id: d.id, status: body.status });
        return { ok: true, status: body.status };
    });
    route('GET', '/api/elders/:id/appointments', {}, ({ user, params }) => { const a = need(user, params.id); return { appointments: apptsFor(a.elder) }; });
    route('POST', '/api/elders/:id/appointments', {}, ({ user, params, body }) => {
        const a = need(user, params.id, true);
        const title = U.clean(body.title, 100);
        if (!title) throw new HttpError(400, 'Give the appointment a title.');
        const m = /^(\d{4}-\d{2}-\d{2})T([01]\d|2[0-3]):([0-5]\d)$/.exec(String(body.starts_local || ''));
        if (!m || !U.isDate(m[1])) throw new HttpError(400, 'Choose a date and time.');
        const startsMs = U.localToUtcMs(m[1], `${m[2]}:${m[3]}`, a.elder.tz_offset_min);
        if (startsMs < now() - 3600e3) throw new HttpError(400, 'That time is in the past.');
        db.prepare('INSERT INTO appointments(elder_id, title, doctor, location, notes, starts_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
            .run(a.elder.id, title, U.clean(body.doctor, 80), U.clean(body.location, 120), U.clean(body.notes, 200), U.iso(startsMs), user.id, nowIso());
        publish(a.elder.id, 'appts', {});
        return { appointments: apptsFor(a.elder) };
    });
    route('DELETE', '/api/appointments/:id', {}, ({ user, params }) => {
        const ap = db.prepare('SELECT * FROM appointments WHERE id = ? AND cancelled = 0').get(Number(params.id));
        if (!ap) throw new HttpError(404, 'Not found.');
        const a = need(user, ap.elder_id, true);
        db.prepare('UPDATE appointments SET cancelled = 1 WHERE id = ?').run(ap.id);
        publish(a.elder.id, 'appts', {});
        return { appointments: apptsFor(a.elder) };
    });
    const daysParam = q => ([1, 7, 14, 30].includes(Number(q.days)) ? Number(q.days) : 7);
    route('GET', '/api/elders/:id/adherence', {}, ({ user, params, query }) => buildDigest(db, need(user, params.id).elder, daysParam(query), now()));
    route('GET', '/api/elders/:id/digest', {}, ({ user, params, query }) => buildDigest(db, need(user, params.id).elder, daysParam(query), now()));
    route('POST', '/api/elders/:id/digest/send', {}, async ({ user, params, body }) => {
        const a = need(user, params.id);
        if (!limiters.digest.hit('u' + user.id)) throw new HttpError(429, 'You can email yourself 5 summaries an hour.');
        const days = daysParam(body || {});
        const d = buildDigest(db, a.elder, days, now());
        const ok = await worker.queue({ key: `digest-manual:${user.id}:${a.elder.id}:${now()}`, user, elderId: a.elder.id, kind: 'digest_manual', mail: T.digest(d, user.name, cfg.appUrl) });
        return { ok, to: user.email, provider: mailer.provider };
    });
    route('GET', '/api/notifications', {}, ({ user }) => ({ notifications: db.prepare(`SELECT id, kind, subject, status, created_at, sent_at, substr(body_text, 1, 400) AS preview
        FROM email_log WHERE to_user_id = ? ORDER BY id DESC LIMIT 50`).all(user.id) }));

    route('GET', '/api/elders/:id/stream', {}, ({ req, res, user, params }) => {
        const a = need(user, params.id);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.write('retry: 3000\n\n');
        const set = streams.get(a.elder.id) || new Set();
        streams.set(a.elder.id, set); set.add(res);
        const ping = setInterval(() => res.write(': ping\n\n'), 25000);
        req.on('close', () => { clearInterval(ping); set.delete(res); if (!set.size) streams.delete(a.elder.id); });
        return undefined;
    });

    route('POST', '/api/cron/tick', { auth: false, csrf: false }, async ({ req }) => {
        const secret = env.CRON_SECRET;
        if (!secret || !sec.safeEqual(req.headers['x-cron-secret'] || '', secret)) throw new HttpError(404, 'Not found.');
        return { ok: true, stats: await worker.tick(now()) };
    });

    /* ---------- HTTP plumbing ---------- */
    function headers(res) {
        res.setHeader('Content-Security-Policy', CSP + (prod ? '; upgrade-insecure-requests' : ''));
        res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
        res.setHeader('X-ElderEase-Server', '1');                 // lets the pages tell this server from plain static hosting without a failed API call
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin'); res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
        res.setHeader('Permissions-Policy', 'camera=(), payment=(), usb=(), microphone=(self), geolocation=(self)');
        if (prod) res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains');
    }
    const sendJson = (res, status, obj) => { const b = JSON.stringify(obj); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(b) }); res.end(b); };
    function readBody(req) {
        return new Promise((resolve, reject) => {
            let size = 0; const chunks = [];
            req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new HttpError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
            req.on('end', () => { if (!chunks.length) return resolve({}); try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {}); } catch (e) { reject(new HttpError(400, 'Invalid JSON.')); } });
            req.on('error', reject);
        });
    }
    function serveStatic(req, res, pathname) {
        let rel = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
        const file = path.resolve(siteDir, '.' + rel);
        if (!file.startsWith(siteDir + path.sep) || path.basename(file).startsWith('.') || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
        const ext = path.extname(file).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': ext === '.woff2' ? 'public, max-age=31536000, immutable' : 'no-cache' });
        if (req.method === 'HEAD') return res.end();
        fs.createReadStream(file).pipe(res);
    }

    const server = http.createServer(async (req, res) => {
        headers(res);
        try {
            const url = new URL(req.url, 'http://x');
            if (!url.pathname.startsWith('/api/')) {
                if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
                return serveStatic(req, res, url.pathname);
            }
            if (!limiters.api.hit(clientIp(req))) throw new HttpError(429, 'Slow down a little.');
            const r = routes.find(x => x.method === req.method && x.re.test(url.pathname));
            if (!r) throw new HttpError(404, 'Not found.');
            if (r.method !== 'GET' && r.csrf) {                                                // custom header + same-origin check blocks cross-site form posts
                const origin = req.headers.origin;
                if (req.headers['x-requested-with'] !== 'ElderEase' || (origin && new URL(origin).host !== req.headers.host)) throw new HttpError(403, 'Blocked.');
            }
            const user = r.auth ? sessionUser(req) : null;
            if (r.auth && !user) throw new HttpError(401, 'Please sign in.');
            const body = r.method === 'GET' ? {} : await readBody(req);
            const out = await r.fn({ req, res, user, body, params: url.pathname.match(r.re).groups || {}, query: Object.fromEntries(url.searchParams) });
            if (out !== undefined) sendJson(res, 200, out);
        } catch (e) {
            if (res.headersSent) return res.end();
            if (e instanceof HttpError) return sendJson(res, e.status, { error: e.message });
            log('error', e && e.stack || e);
            sendJson(res, 500, { error: 'Something went wrong on our side.' });
        }
    });
    return { server, db, worker, publish, config: cfg, close: () => new Promise(r => { for (const s of streams.values()) for (const x of s) x.end(); server.close(() => { db.close(); r(); }); server.closeAllConnections && server.closeAllConnections(); }) };
}
module.exports = { createApp };
