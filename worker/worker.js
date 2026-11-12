// Cloudflare Worker entry. All logic (and its tests) live in relay.js; this module may only export handlers.
import { handleRequest } from './relay.js';

export default {
  fetch(request, env) { return handleRequest(request, env); },
};
