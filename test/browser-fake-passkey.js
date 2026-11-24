// Paste into a page on the local test server to stand in for Face ID.
// Creates a real P-256 passkey with WebCrypto and answers
// navigator.credentials.create/get exactly like a phone would. The key is
// kept in sessionStorage (under a name) so "closing and reopening" the app
// can be simulated with a reload.
window.installFakePasskey = async (name = 'phone') => {
  const enc = new TextEncoder();
  const b64u = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const unb64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
  const sha = async d => new Uint8Array(await crypto.subtle.digest('SHA-256', d));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
  const head = (m, n) => (n < 24 ? [(m << 5) | n] : n < 256 ? [(m << 5) | 24, n] : [(m << 5) | 25, n >> 8, n & 255]);
  const cbor = v => {
    if (typeof v === 'number') return Uint8Array.from(v >= 0 ? head(0, v) : head(1, -1 - v));
    if (typeof v === 'string') { const b = enc.encode(v); return cat(Uint8Array.from(head(3, b.length)), b); }
    if (v instanceof Uint8Array) return cat(Uint8Array.from(head(2, v.length)), v);
    return cat(Uint8Array.from(head(5, v.size)), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)]));
  };
  // WebCrypto gives raw r||s; WebAuthn wants a DER signature.
  const der = raw => {
    const int = b => { let i = 0; while (i < b.length - 1 && b[i] === 0) i++; b = b.slice(i); if (b[0] & 0x80) b = cat(Uint8Array.of(0), b); return cat(Uint8Array.of(2, b.length), b); };
    const r = int(raw.slice(0, 32)), s = int(raw.slice(32));
    return cat(Uint8Array.of(0x30, r.length + s.length), r, s);
  };
  const u32 = n => Uint8Array.of(n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255);
  const clientData = (type, challenge) => enc.encode(JSON.stringify({ type, challenge: b64u(challenge), origin: location.origin, crossOrigin: false }));
  const storeKey = `fakePasskey:${name}`;

  let state = null; // { key: CryptoKeyPair, credId, userHandle }
  const saved = sessionStorage.getItem(storeKey);
  if (saved) {
    const s = JSON.parse(saved);
    state = {
      key: { privateKey: await crypto.subtle.importKey('jwk', s.priv, { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) },
      credId: unb64u(s.credId),
      userHandle: unb64u(s.userHandle),
    };
  }

  navigator.credentials.create = async ({ publicKey: o }) => {
    const key = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    const jwk = await crypto.subtle.exportKey('jwk', key.publicKey);
    const credId = crypto.getRandomValues(new Uint8Array(16));
    const userHandle = new Uint8Array(o.user.id);
    state = { key, credId, userHandle };
    sessionStorage.setItem(storeKey, JSON.stringify({ priv: await crypto.subtle.exportKey('jwk', key.privateKey), credId: b64u(credId), userHandle: b64u(userHandle) }));
    const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, unb64u(jwk.x)], [-3, unb64u(jwk.y)]]));
    const authData = cat(await sha(enc.encode(o.rp.id)), Uint8Array.of(0x45), u32(0), new Uint8Array(16), Uint8Array.of(0, credId.length), credId, cose);
    const att = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
    return {
      id: b64u(credId), rawId: credId.buffer, type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: clientData('webauthn.create', o.challenge).buffer, attestationObject: att.buffer, getTransports: () => ['internal', 'hybrid'] },
      getClientExtensionResults: () => ({}),
    };
  };

  navigator.credentials.get = async ({ publicKey: o }) => {
    if (!state) throw new DOMException('No passkey on this phone', 'NotAllowedError');
    const cdj = clientData('webauthn.get', o.challenge);
    const authData = cat(await sha(enc.encode(o.rpId)), Uint8Array.of(0x05), u32(0));
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, state.key.privateKey, cat(authData, await sha(cdj))));
    return {
      id: b64u(state.credId), rawId: state.credId.buffer, type: 'public-key', authenticatorAttachment: 'platform',
      response: { clientDataJSON: cdj.buffer, authenticatorData: authData.buffer, signature: der(raw).buffer, userHandle: state.userHandle.buffer },
      getClientExtensionResults: () => ({}),
    };
  };
  return `fake passkey "${name}" ready${state ? ' (existing key restored)' : ''}`;
};
