import crypto from 'node:crypto';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

/** STUN (free, public) plus optional TURN with short-lived per-user credentials. */
export function iceServersFor(userId) {
  const { stunUrls, turnUrls, turnSecret, turnUsername, turnCredential, turnTtlSeconds } = config.calls;
  const servers = [];
  if (stunUrls.length) servers.push({ urls: stunUrls });
  if (turnUrls.length) {
    if (turnSecret) {
      const username = `${Math.floor(Date.now() / 1000) + turnTtlSeconds}:${userId}`;
      const credential = crypto.createHmac('sha1', turnSecret).update(username).digest('base64');
      servers.push({ urls: turnUrls, username, credential });
    } else if (turnUsername) {
      servers.push({ urls: turnUrls, username: turnUsername, credential: turnCredential });
    }
  }
  return servers;
}

/**
 * Live calls of both kinds (one-to-one and group), shared by callService and
 * groupCallService so a person is in at most one call at a time, whichever kind.
 * Kept in memory: one API process (like presence).
 */
export const live = new Map(); // callId -> call
export const callOfUser = new Map(); // userId -> callId (people in a call, or calling)

const endedListeners = new Set(); // ({ id, conversationId }) => void
const hostListeners = new Set(); // ({ callId, hostId, previousHostId }) => void

function notify(listeners, payload, what) {
  for (const listener of listeners) {
    try {
      listener(payload);
    } catch (error) {
      logger.error(`Call ${what} listener failed`, { error });
    }
  }
}

export const callEvents = {
  onEnded(listener) {
    endedListeners.add(listener);
    return () => endedListeners.delete(listener);
  },
  onHostChanged(listener) {
    hostListeners.add(listener);
    return () => hostListeners.delete(listener);
  },
  ended: (payload) => notify(endedListeners, payload, 'ended'),
  hostChanged: (payload) => notify(hostListeners, payload, 'host change'),
};
