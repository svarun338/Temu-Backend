import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { blockRepository } from '../repositories/blockRepository.js';
import { callRepository } from '../repositories/callRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { realtime } from '../sockets/realtime.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { conversationService } from './conversationService.js';
import { messageService } from './messageService.js';
import { notificationService } from './notificationService.js';
import { callEvents, callOfUser, iceServersFor, live } from './callRegistry.js';
import { groupCallService } from './groupCallService.js';
import { avatarUrl } from './serializers.js';

/**
 * One-to-one voice/video calls. The server is the referee: it decides who is
 * calling whom, enforces blocks and "busy", times out unanswered calls and
 * relays WebRTC signalling between exactly two browser tabs. Audio and video
 * never pass through the server.
 *
 * Live calls are kept in memory (one API process, like presence); the
 * `calls` table is the history. Each live call:
 * { id, conversationId, callerId, calleeId, type, status, createdAt, answeredAt,
 *   callerTab, calleeTab, ringTimer, graceTimers: Map<userId, timer>,
 *   joined: [userId…] in the order people joined, hostId }
 *
 * Host: the person who started the call. Only the host may record it. When the host's
 * tab disconnects, the next person who joined (and is still connected) becomes host;
 * a host who comes back does not take it back.
 */

/** Is this participant's call tab connected right now? */
function isInCall(call, userId) {
  const tab = userId === call.callerId ? call.callerTab : userId === call.calleeId ? call.calleeTab : null;
  return Boolean(tab) && realtime.isTabConnected(userId, tab);
}

/** Hand the host role to the first person, in joining order, who is still connected. */
function passHost(call) {
  const next = call.joined.find((userId) => userId !== call.hostId && isInCall(call, userId));
  if (!next) return; // nobody else here: the host stays host
  const previousHostId = call.hostId;
  call.hostId = next;
  realtime.emitToUsers([call.callerId, call.calleeId], 'call:host', { callId: call.id, hostId: next, previousHostId });
  callEvents.hostChanged({ callId: call.id, hostId: next, previousHostId });
}

const notFound = () => AppError.notFound('This call has ended');

const person = (user) => ({ id: user.id, name: user.name, avatarUrl: avatarUrl(user.avatar_path) });

/** What both tabs need to show a live call. */
function toLiveCall(call, caller, callee) {
  return {
    id: call.id,
    conversationId: call.conversationId,
    type: call.type,
    status: call.status,
    caller: person(caller),
    callee: person(callee),
    createdAt: call.createdAt.toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
    hostId: call.hostId ?? call.callerId ?? null,
  };
}

const durationSec = (row) =>
  row.answered_at && row.ended_at ? Math.max(0, Math.round((new Date(row.ended_at) - new Date(row.answered_at)) / 1000)) : 0;

/**
 * A history row as seen by `viewerId`. Group calls show the group as the "peer"; for
 * someone who was rung but never joined, a group call counts as missed.
 */
export function toCallLog(row, viewerId) {
  const outgoing = row.caller_id === viewerId;
  const group = Boolean(Number(row.is_group));
  const joined = !group || outgoing || Boolean(row.my_joined_at);
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type,
    group,
    status: joined ? row.status : 'missed',
    direction: outgoing ? 'outgoing' : 'incoming',
    peer: group
      ? { id: null, name: row.group_name ?? 'Group', avatarUrl: avatarUrl(row.group_avatar_path), isGroup: true }
      : { id: row.peer_id, name: row.peer_name, avatarUrl: row.peer_blocked_me ? null : avatarUrl(row.peer_avatar_path) },
    createdAt: new Date(row.created_at).toISOString(),
    answeredAt: row.answered_at ? new Date(row.answered_at).toISOString() : null,
    endedAt: row.ended_at ? new Date(row.ended_at).toISOString() : null,
    durationSec: joined ? durationSec(row) : 0,
  };
}

function forget(call) {
  clearTimeout(call.ringTimer);
  for (const timer of call.graceTimers.values()) clearTimeout(timer);
  live.delete(call.id);
  if (callOfUser.get(call.callerId) === call.id) callOfUser.delete(call.callerId);
  if (callOfUser.get(call.calleeId) === call.id) callOfUser.delete(call.calleeId);
}

function liveCallFor(userId, callId) {
  const call = live.get(callId);
  if (!call || call.isGroup || (call.callerId !== userId && call.calleeId !== userId)) throw notFound();
  return call;
}

export const callService = {
  /** STUN (free, public) plus optional TURN with short-lived per-user credentials. */
  iceServers: (userId) => iceServersFor(userId),

  /** Is this user in a call (ringing or connected)? */
  isBusy(userId) {
    return callOfUser.has(userId);
  },

  /**
   * This user's connected call (one-to-one or group):
   * { id, conversationId, type, hostId, isGroup, participantIds } — participantIds: who is in it now.
   */
  ongoingCall(userId, callId) {
    if (live.get(callId)?.isGroup) return groupCallService.ongoingCall(userId, callId);
    const call = liveCallFor(userId, callId);
    if (call.status !== 'ongoing') throw new AppError(409, 'CALL_NOT_CONNECTED', 'The call is not connected');
    const { id, conversationId, type, hostId } = call;
    return { id, conversationId, type, hostId, isGroup: false, participantIds: [call.callerId, call.calleeId] };
  },

  /** People in a live call right now (empty once it is over). */
  participantsOf(callId) {
    const call = live.get(callId);
    if (!call) return [];
    return call.isGroup ? [...call.participants.keys()] : [call.callerId, call.calleeId];
  },

  /** Run `listener({ callId, hostId, previousHostId })` whenever a call's host changes. */
  onHostChanged: (listener) => callEvents.onHostChanged(listener),

  /** Run `listener({ id, conversationId })` after every call ends. Returns a function that removes it. */
  onCallEnded: (listener) => callEvents.onEnded(listener),

  /** Hang up whatever call this user is in (account deletion). */
  async endAllFor(userId) {
    const callId = callOfUser.get(userId);
    if (!callId) return;
    if (live.get(callId)?.isGroup) await groupCallService.leave(userId, callId);
    else await this.end(userId, callId);
  },

  /**
   * Ring the other person of a direct chat. Returns { call, iceServers }.
   * If they are already in a call the attempt is logged as "busy" and nothing rings.
   */
  async start(userId, tabId, { conversationId, type }) {
    await conversationService.assertParticipant(conversationId, userId);
    if ((await conversationRepository.getType(conversationId)) !== 'direct') {
      throw AppError.badRequest('Calls are only available in one-to-one chats');
    }
    const peerId = (await conversationRepository.listParticipantIds(conversationId)).find((id) => id !== userId);
    if (!peerId) throw AppError.badRequest('There is nobody to call in this chat');

    const { blockedByMe, blockedMe } = await blockRepository.relation(userId, peerId);
    if (blockedByMe) throw new AppError(403, 'BLOCKED', 'You blocked this user. Unblock them to call.');
    // Deliberately vague, like messaging: don't confirm that they blocked you.
    if (blockedMe) throw new AppError(403, 'CANNOT_CALL', "You can't call this user.");
    if (callOfUser.has(userId)) throw new AppError(409, 'ALREADY_IN_CALL', 'You are already in a call');

    const [caller, callee] = await Promise.all([userRepository.findById(userId), userRepository.findById(peerId)]);
    const now = new Date();

    if (callOfUser.has(peerId)) {
      const id = await callRepository.create({ conversationId, callerId: userId, calleeId: peerId, type, status: 'busy', at: now });
      await this.recordInChat(await callRepository.findById(id));
      const call = { id, conversationId, type, status: 'busy', createdAt: now, answeredAt: null };
      return { call: toLiveCall(call, caller, callee), iceServers: [] };
    }

    const id = await callRepository.create({ conversationId, callerId: userId, calleeId: peerId, type, at: now });
    const call = {
      id,
      conversationId,
      callerId: userId,
      calleeId: peerId,
      type,
      status: 'ringing',
      createdAt: now,
      answeredAt: null,
      callerTab: tabId,
      calleeTab: null,
      graceTimers: new Map(),
      caller,
      callee,
      joined: [userId],
      hostId: userId,
    };
    call.ringTimer = setTimeout(() => {
      this.finish(call, 'missed', null).catch((error) => logger.error('Call timeout failed', { callId: id, error }));
    }, config.calls.ringTimeoutMs);
    live.set(id, call);
    callOfUser.set(userId, id);
    callOfUser.set(peerId, id);

    const payload = toLiveCall(call, caller, callee);
    realtime.emitToUsers([peerId], 'call:incoming', { call: payload, iceServers: this.iceServers(peerId) });
    notificationService.run(() => notificationService.callRinging({ call: payload, calleeId: peerId }), { userId });
    return { call: payload, iceServers: this.iceServers(userId) };
  },

  /** Answer on this tab. Other tabs of mine stop ringing; the caller starts the WebRTC offer. */
  async accept(userId, tabId, callId) {
    const call = liveCallFor(userId, callId);
    if (call.calleeId !== userId) throw AppError.badRequest('Only the person being called can answer');
    if (call.status !== 'ringing') throw new AppError(409, 'CALL_ANSWERED', 'This call was already answered');
    const now = new Date();
    if (!(await callRepository.markAnswered(callId, now))) throw notFound();
    clearTimeout(call.ringTimer);
    Object.assign(call, { status: 'ongoing', answeredAt: now, calleeTab: tabId });
    call.joined.push(userId);

    const payload = toLiveCall(call, call.caller, call.callee);
    realtime.toTab(call.callerId, call.callerTab, 'call:accepted', { call: payload });
    realtime.toUserExceptTab(userId, tabId, 'call:handled', { callId });
    return { call: payload, iceServers: this.iceServers(userId) };
  },

  async reject(userId, callId) {
    const call = liveCallFor(userId, callId);
    if (call.calleeId !== userId || call.status !== 'ringing') throw AppError.badRequest('Only an incoming call can be declined');
    await this.finish(call, 'rejected', userId);
  },

  /** Hang up: cancels a call that is still ringing (missed for them) or ends a connected one. */
  async end(userId, callId) {
    const call = live.get(callId);
    if (call?.isGroup) return groupCallService.leave(userId, callId);
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return; // already over: nothing to do
    let status = 'ended';
    if (call.status === 'ringing') status = userId === call.callerId ? 'missed' : 'rejected';
    await this.finish(call, status, userId);
  },

  /** Relay an offer / answer / ICE candidate / mic-camera state to the other party's tab. */
  signal(userId, tabId, { callId, data }) {
    const call = liveCallFor(userId, callId);
    if (call.status !== 'ongoing') throw new AppError(409, 'CALL_NOT_CONNECTED', 'The call is not connected');
    const isCaller = userId === call.callerId;
    if ((isCaller ? call.callerTab : call.calleeTab) !== tabId) throw notFound(); // another tab of mine
    const [toUser, toTab] = isCaller ? [call.calleeId, call.calleeTab] : [call.callerId, call.callerTab];
    realtime.toTab(toUser, toTab, 'call:signal', { callId, data });
  },

  /** The call is over: store the outcome, tell both sides and leave a note in the chat. */
  async finish(call, status, endedBy) {
    if (!live.has(call.id)) return;
    forget(call);
    const now = new Date();
    if (!(await callRepository.finish(call.id, { status, endedBy, at: now }))) return;
    realtime.emitToUsers([call.callerId, call.calleeId], 'call:ended', { callId: call.id, status, endedBy });
    callEvents.ended({ id: call.id, conversationId: call.conversationId });
    const row = await callRepository.findById(call.id);
    await this.recordInChat(row);
    if (status === 'missed') {
      notificationService.run(() => notificationService.callMissed({ call: toLiveCall(call, call.caller, call.callee), calleeId: call.calleeId }), {
        userId: call.callerId,
      });
    }
  },

  /** "Missed voice call" / "Video call · 2:31" in the chat, from the caller. */
  async recordInChat(row) {
    const at = new Date(row.ended_at ?? Date.now());
    const data = { callId: row.id, type: row.type, status: row.status, durationSec: durationSec(row), callerId: row.caller_id };
    const messageId = await withTransaction(async (connection) => {
      await conversationRepository.lockForUpdate(connection, row.conversation_id);
      const id = await messageRepository.insertEvent(connection, { conversationId: row.conversation_id, actorId: row.caller_id, type: 'call', data, at });
      await conversationRepository.setLastMessage(connection, { conversationId: row.conversation_id, messageId: id, at });
      return id;
    });
    const message = await messageService.broadcastCopy(messageId);
    realtime.broadcastMessage({ message, participantIds: [row.caller_id, row.callee_id] });
    return message;
  },

  /** A tab's socket went away. Its call survives a reconnect within the grace period. */
  tabDisconnected(userId, tabId) {
    const call = live.get(callOfUser.get(userId));
    if (!call) return;
    if (call.isGroup) return groupCallService.tabDisconnected(userId, tabId);
    const mine = userId === call.callerId ? call.callerTab : call.calleeTab;
    if (mine !== tabId || realtime.isTabConnected(userId, tabId)) return;
    if (call.status === 'ongoing' && call.hostId === userId) passHost(call);
    clearTimeout(call.graceTimers.get(userId));
    call.graceTimers.set(
      userId,
      setTimeout(() => {
        if (realtime.isTabConnected(userId, tabId)) return;
        const status = call.status === 'ringing' ? 'missed' : 'ended';
        this.finish(call, status, userId).catch((error) => logger.error('Call cleanup failed', { callId: call.id, error }));
      }, config.calls.reconnectGraceMs),
    );
  },

  /** A tab (re)connected: keep its call alive, and ring a callee who just came online. */
  tabConnected(socket) {
    const { user, tabId } = socket.data;
    const call = live.get(callOfUser.get(user.id));
    if (!call) return;
    if (call.isGroup) return groupCallService.tabConnected(socket);
    clearTimeout(call.graceTimers.get(user.id));
    call.graceTimers.delete(user.id);
    if (call.status === 'ringing' && call.calleeId === user.id) {
      socket.emit('call:incoming', { call: toLiveCall(call, call.caller, call.callee), iceServers: this.iceServers(user.id) });
    }
    if (call.status === 'ongoing') {
      const mine = user.id === call.callerId ? call.callerTab : call.calleeTab;
      if (mine === tabId) {
        // The host was away when everyone else was too: the first one back takes over.
        if (!isInCall(call, call.hostId)) passHost(call);
        socket.emit('call:resumed', { callId: call.id, hostId: call.hostId });
      }
    }
  },

  async history(userId, { before, limit }) {
    const rows = await callRepository.listForUser(userId, { before, limit });
    return { calls: rows.map((row) => toCallLog(row, userId)), hasMore: rows.length === limit };
  },

  async hide(userId, { callIds, all }) {
    if (all) await callRepository.hideAll(userId);
    else await callRepository.hide(userId, callIds);
  },

  /** On startup nothing can still be live: close calls left open by a crash or restart. */
  async closeStale() {
    const count = await callRepository.finishStale(new Date());
    if (count) logger.info('Closed calls left open by a restart', { count });
  },

  /** Tests: forget all live calls. */
  reset() {
    for (const call of live.values()) {
      if (call.isGroup) groupCallService.forget(call);
      else forget(call);
    }
  },
};
