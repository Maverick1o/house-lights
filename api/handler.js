// Single serverless function for the whole API (keeps us well inside the
// Vercel Hobby plan). vercel.json routes every /api/* request here.
import { createApp } from '../lib/server.js';
import { createUpstashStore } from '../lib/store.js';

let app;
const handle = request => (app ??= createApp({ store: createUpstashStore(process.env) }))(request);

export { handle as GET, handle as POST, handle as PUT, handle as DELETE };
