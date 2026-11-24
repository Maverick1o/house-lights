// Small key-value store used by the backend.
//
// Production uses Upstash Redis (free tier, added through the Vercel
// Marketplace). Tests use the in-memory version below, which behaves the same
// for every command the backend uses.

import { Redis } from '@upstash/redis';

// Vercel's Upstash integration names its variables KV_REST_API_*; a direct
// Upstash setup uses UPSTASH_REDIS_REST_*. Accept either.
export function createUpstashStore(env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  const redis = new Redis({ url, token });
  return {
    get: key => redis.get(key),
    // Returns true if the value was written (false when nx and the key exists).
    set: async (key, value, { ex, nx } = {}) => {
      const opts = {};
      if (ex) opts.ex = ex;
      if (nx) opts.nx = true;
      return (await redis.set(key, value, opts)) === 'OK';
    },
    getdel: key => redis.getdel(key),
    del: (...keys) => (keys.length ? redis.del(...keys) : 0),
    sadd: (key, member) => redis.sadd(key, member),
    srem: (key, member) => redis.srem(key, member),
    smembers: async key => (await redis.smembers(key)) || [],
    incr: key => redis.incr(key),
    expire: (key, seconds) => redis.expire(key, seconds),
  };
}

export function createMemoryStore(now = () => Date.now()) {
  const data = new Map(); // key -> { value, expires }
  const live = key => {
    const e = data.get(key);
    if (!e) return null;
    if (e.expires && e.expires <= now()) { data.delete(key); return null; }
    return e;
  };
  const clone = v => (v === undefined ? null : structuredClone(v));
  return {
    data,
    async get(key) { return clone(live(key)?.value); },
    async set(key, value, { ex, nx } = {}) {
      if (nx && live(key)) return false;
      data.set(key, { value: clone(value), expires: ex ? now() + ex * 1000 : 0 });
      return true;
    },
    async getdel(key) { const e = live(key); data.delete(key); return clone(e?.value); },
    async del(...keys) { let n = 0; for (const k of keys) if (data.delete(k)) n++; return n; },
    async sadd(key, member) {
      const e = live(key) || { value: [], expires: 0 };
      if (!e.value.includes(member)) e.value.push(member);
      data.set(key, e);
      return 1;
    },
    async srem(key, member) {
      const e = live(key);
      if (e) e.value = e.value.filter(m => m !== member);
      return 1;
    },
    async smembers(key) { return [...(live(key)?.value || [])]; },
    async incr(key) {
      const e = live(key) || { value: 0, expires: 0 };
      e.value += 1;
      data.set(key, e);
      return e.value;
    },
    async expire(key, seconds) { const e = live(key); if (e) e.expires = now() + seconds * 1000; return e ? 1 : 0; },
  };
}
