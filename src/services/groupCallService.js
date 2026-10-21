import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { callRepository } from '../repositories/callRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { groupRepository } from '../repositories/groupRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { userRepository } from '../repositories/userRepository.js';
import { realtime } from '../sockets/realtime.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { callEvents, callOfUser, iceServersFor, live } from './callRegistry.js';
import { messageService } from './messageService.js';
import { avatarUrl } from './serializers.js';

/**
 * Group voice/video calls (mesh: every participant connects directly to every other,
 * so a call holds at most MAX_GROUP_CALL_PARTICIPANTS people). The server rings the
 * group, keeps track of who is in the call and relays WebRTC signalling between two
 * participants' tabs; audio and video never pass through it.
 *
 * Flow: a member starts the call (they are in it at once) and the other members ring.
 * Anyone in the group may join while the call goes on, until it is full. The newcomer
 * sends an offer to everyone already in the call. The call ends when one person is
 * left, or, if nobody answered, when the ringing times out.
 *
 * Host: the person who started; when the host leaves or their connection drops, the
 * next person who joined and is still connected takes over. Only the host can record.
 *
 * Live group call (in callRegistry.live, with isGroup: true):
 * { id, conversationId, type, status: 'ringing'|'ongoing', createdAt, answeredAt, callerId,
 *   group: { name, avatarUrl }, people: Map<userId, person>, invited: Set, declined: Set,
 *   participants: Map<userId, { tabId, joinedAt }>, joined: [userId…], hostId,
 *   ringTimer, graceTimers: Map<userId, timer> }
 */
const callOfGroup = new Map(); // conversationId -> callId (one call per group at a time)

const notFound = () => AppError.notFound('This call has ended');
const person = (user) => ({ id: user.id, name: user.name, avatarUrl: avatarUrl(user.avatar_path) });

function toPayload(call) {
  return {
    id: call.id,
    conversationId: call.conversationId,
    type: call.type,
    status: call.status,
    group: { id: call.conversationId, name: call.group.name, avatarUrl: call.group.avatarUrl },
    startedBy: call.people.get(call.callerId) ?? { id: call.callerId, name: 'Someone', avatarUrl: null },
    hostId: call.hostId,
    maxParticipants: config.calls.maxGroupParticipants,
    participants: [...call.participants].map(([userId, p]) => ({ ...personOf(call, userId), joinedAt: p.joinedAt.toISOString() })),
    createdAt: call.createdAt.toISOString(),
    answeredAt: call.answeredAt?.toISOString() ?? null,
  };
}

function personOf(call, userId) {
  return call.people.get(userId) ?? { id: userId, name: 'Someone', avatarUrl: null };
}

function liveGroupCall(callId) {
  const call = live.get(callId);
  if (!call?.isGroup) throw notFound();
  return call;
}

const isConnected = (call, userId) => {
  const p = call.participants.get(userId);
  return Boolean(p) && realtime.isTabConnected(userId, p.tabId);
};

/** Everyone who should see the call's state change: the whole group as it was when the call started. */
const audience = (call) => [...new Set([...call.invited, ...call.participants.keys()])];

/** The host left or dropped: the next person who joined and is still connected takes over. */
function passHost(call) {
  const next = call.joined.find((userId) => userId !== call.hostId && isConnected(call, userId));
  if (!next) return;
  const previousHostId = call.hostId;
  call.hostId = next;
  realtime.emitToUsers([...call.participants.keys()], 'groupcall:host', { callId: call.id, hostId: next, previousHostId });
  callEvents.hostChanged({ callId: call.id, hostId: next, previousHostId });
}

const durationSec = (row) =>
  row.answered_at && row.ended_at ? Math.max(0, Math.round((new Date(row.ended_at) - new Date(row.answered_at)) / 1000)) : 0;

export const groupCallService = {
  /** Start a call in a group chat. Returns { call, iceServers }. */
  async start(userId, tabId, { conversationId, type }) {
    if (!(await conversationRepository.isParticipant(conversationId, userId))) throw AppError.notFound('Conversation not found');
    if ((await conversationRepository.getType(conversationId)) !== 'group') throw AppError.badRequest('Group calls are for group chats');
    const [memberIds, group] = await Promise.all([conversationRepository.listParticipantIds(conversationId), groupRepository.find(conversationId)]);
    if (memberIds.length < 2) throw AppError.badRequest('There is nobody else in this group to call');
    const people = new Map((await userRepository.findManyByIds(memberIds)).map((user) => [user.id, person(user)]));

    // Checked again right before going live: nothing async may happen in between.
    if (callOfUser.has(userId)) throw new AppError(409, 'ALREADY_IN_CALL', 'You are already in a call');
    if (callOfGroup.has(conversationId)) {
      throw new AppError(409, 'CALL_IN_PROGRESS', 'A call is already going on in this group. Join it instead.', { callId: callOfGroup.get(conversationId) });
    }
    const now = new Date();
    const id = await callRepository.create({ conversationId, callerId: userId, type, isGroup: true, at: now });
    if (callOfUser.has(userId) || callOfGroup.has(conversationId)) {
      // Lost a race with another start: close this one quietly.
      await callRepository.finish(id, { status: 'failed', endedBy: userId, at: now });
      throw new AppError(409, 'CALL_IN_PROGRESS', 'A call is already going on in this group. Join it instead.', { callId: callOfGroup.get(conversationId) });
    }
    const call = {
      id,
      isGroup: true,
      conversationId,
      type,
      status: 'ringing',
      createdAt: now,
      answeredAt: null,
      callerId: userId,
      group: { name: group?.name ?? 'Group', avatarUrl: avatarUrl(group?.avatar_path) },
      people,
      invited: new Set(memberIds),
      declined: new Set(),
      participants: new Map([[userId, { tabId, joinedAt: now }]]),
      joined: [userId],
      hostId: userId,
      graceTimers: new Map(),
    };
    live.set(id, call);
    callOfUser.set(userId, id);
    callOfGroup.set(conversationId, id);
    await callRepository.invite(id, memberIds, { at: now, joinedId: userId });

    call.ringTimer = setTimeout(() => this.ringTimedOut(call), config.calls.ringTimeoutMs);
    const payload = toPayload(call);
    // Everyone else rings, except people busy in another call (they still see "Join").
    const ring = memberIds.filter((memberId) => memberId !== userId && !callOfUser.has(memberId));
    for (const memberId of ring) realtime.emitToUsers([memberId], 'groupcall:incoming', { call: payload, iceServers: iceServersFor(memberId) });
    realtime.emitToUsers(memberIds, 'groupcall:updated', { call: payload });
    return { call: payload, iceServers: iceServersFor(userId) };
  },

  /** Nobody answered: the call is missed. Otherwise phones that are still ringing stop. */
  ringTimedOut(call) {
    if (!live.has(call.id)) return;
    if (call.status === 'ringing') {
      this.finish(call, 'missed', null).catch((error) => logger.error('Group call timeout failed', { callId: call.id, error }));
      return;
    }
    const stillRinging = [...call.invited].filter((userId) => !call.participants.has(userId));
    realtime.emitToUsers(stillRinging, 'groupcall:handled', { callId: call.id });
  },

  /** Join a call in one of my groups (also after the ringing stopped), unless it is full. */
  async join(userId, tabId, callId) {
    let call = liveGroupCall(callId);
    if (!(await conversationRepository.isParticipant(call.conversationId, userId))) throw notFound();
    if (!call.people.has(userId)) {
      const user = await userRepository.findById(userId); // joined the group after the call started
      if (user) call.people.set(userId, person(user));
    }

    // From here on no await until the participant is in: capacity and "busy" stay exact.
    call = liveGroupCall(callId);
    const mine = call.participants.get(userId);
    if (mine) {
      if (mine.tabId === tabId) return { call: toPayload(call), iceServers: iceServersFor(userId) };
      throw new AppError(409, 'ALREADY_IN_CALL', 'You are in this call on another device');
    }
    if (callOfUser.has(userId)) throw new AppError(409, 'ALREADY_IN_CALL', 'You are already in a call');
    if (call.participants.size >= config.calls.maxGroupParticipants) {
      throw new AppError(409, 'CALL_FULL', `This call is full (${config.calls.maxGroupParticipants} people)`);
    }
    const now = new Date();
    const others = [...call.participants.keys()];
    call.participants.set(userId, { tabId, joinedAt: now });
    if (!call.joined.includes(userId)) call.joined.push(userId);
    call.invited.add(userId);
    call.declined.delete(userId);
    callOfUser.set(userId, call.id);
    const answered = call.status === 'ringing';
    if (answered) Object.assign(call, { status: 'ongoing', answeredAt: now });

    const payload = toPayload(call);
    realtime.emitToUsers(others, 'groupcall:joined', { callId: call.id, participant: payload.participants.find((p) => p.id === userId) });
    realtime.toUserExceptTab(userId, tabId, 'groupcall:handled', { callId: call.id });
    realtime.emitToUsers(audience(call), 'groupcall:updated', { call: payload });
    if (answered) await callRepository.markAnswered(call.id, now);
    await callRepository.markJoined(call.id, userId, now);
    return { call: payload, iceServers: iceServersFor(userId) };
  },

  /** Don't join: stop ringing on my tabs. If everyone declines, the call is missed. */
  async decline(userId, callId) {
    const call = liveGroupCall(callId);
    if (!call.invited.has(userId) || call.participants.has(userId)) throw AppError.badRequest('Only an incoming call can be declined');
    call.declined.add(userId);
    realtime.emitToUsers([userId], 'groupcall:handled', { callId });
    const waiting = [...call.invited].filter((id) => !call.participants.has(id) && !call.declined.has(id));
    if (call.status === 'ringing' && waiting.length === 0) await this.finish(call, 'missed', null);
  },

  /** Leave the call. The host role moves on; the call ends when one person is left. */
  async leave(userId, callId) {
    const call = live.get(callId);
    if (!call?.isGroup || !call.participants.has(userId)) return; // already gone
    call.participants.delete(userId);
    clearTimeout(call.graceTimers.get(userId));
    call.graceTimers.delete(userId);
    if (callOfUser.get(userId) === call.id) callOfUser.delete(userId);
    realtime.emitToUsers([...call.participants.keys(), userId], 'groupcall:left', { callId, userId });
    if (call.hostId === userId) passHost(call);

    const remaining = call.participants.size;
    if (remaining === 0 || (call.status === 'ongoing' && remaining === 1)) {
      await this.finish(call, call.status === 'ongoing' ? 'ended' : 'missed', userId);
      return;
    }
    realtime.emitToUsers(audience(call), 'groupcall:updated', { call: toPayload(call) });
    await callRepository.markLeft(call.id, userId, new Date());
  },

  /** Relay an offer / answer / ICE candidate / mic-camera state to one other participant's tab. */
  signal(userId, tabId, { callId, to, data }) {
    const call = liveGroupCall(callId);
    const me = call.participants.get(userId);
    if (!me || me.tabId !== tabId) throw notFound();
    const target = call.participants.get(to);
    if (!target || to === userId) throw AppError.notFound('That person is not in this call');
    realtime.toTab(to, target.tabId, 'groupcall:signal', { callId, from: userId, data });
  },

  /** For recording: this user's connected group call. */
  ongoingCall(userId, callId) {
    const call = liveGroupCall(callId);
    if (!call.participants.has(userId)) throw notFound();
    if (call.status !== 'ongoing') throw new AppError(409, 'CALL_NOT_CONNECTED', 'The call is not connected');
    return { id: call.id, conversationId: call.conversationId, type: call.type, hostId: call.hostId, isGroup: true, participantIds: [...call.participants.keys()] };
  },

  /** Calls going on in my groups (for the "Join call" banner after opening the app). */
  async activeFor(userId) {
    const calls = [];
    for (const callId of callOfGroup.values()) {
      const call = live.get(callId);
      if (call && (await conversationRepository.isParticipant(call.conversationId, userId))) calls.push(toPayload(call));
    }
    return calls;
  },

  /**
   * A tab connected (opened the app, or reconnected): it learns about the calls going on in
   * its groups, and rings if a call is still ringing for this person (not answered, declined or busy).
   */
  greet(socket, conversationIds) {
    const { user } = socket.data;
    const mine = new Set(conversationIds);
    for (const [conversationId, callId] of callOfGroup) {
      const call = live.get(callId);
      if (!call || !mine.has(conversationId) || call.participants.has(user.id)) continue;
      const payload = toPayload(call);
      socket.emit('groupcall:updated', { call: payload });
      const ringing = Date.now() - call.createdAt < config.calls.ringTimeoutMs;
      if (ringing && call.invited.has(user.id) && !call.declined.has(user.id) && !callOfUser.has(user.id)) {
        socket.emit('groupcall:incoming', { call: payload, iceServers: iceServersFor(user.id) });
      }
    }
  },

  /** Someone left or was removed from the group: they leave its call too. */
  async removedFromGroup(conversationId, userId) {
    const callId = callOfGroup.get(conversationId);
    if (callId) await this.leave(userId, callId);
  },

  /** The call is over: store it, tell the group and leave a note in the chat. */
  async finish(call, status, endedBy) {
    if (!live.has(call.id)) return;
    this.forget(call);
    const now = new Date();
    if (!(await callRepository.finish(call.id, { status, endedBy, at: now }))) return;
    await callRepository.markAllLeft(call.id, now);
    realtime.emitToUsers(audience(call), 'groupcall:ended', { callId: call.id, conversationId: call.conversationId, status });
    callEvents.ended({ id: call.id, conversationId: call.conversationId });
    await this.recordInChat(await callRepository.findById(call.id));
  },

  /** "Group video call · 12:31" (or "Missed group call" for those who weren't in it), from whoever started it. */
  async recordInChat(row) {
    const at = new Date(row.ended_at ?? Date.now());
    const participantIds = await callRepository.listJoinedIds(row.id);
    const data = { callId: row.id, type: row.type, status: row.status, durationSec: durationSec(row), callerId: row.caller_id, group: true, participantIds };
    const messageId = await withTransaction(async (connection) => {
      await conversationRepository.lockForUpdate(connection, row.conversation_id);
      const id = await messageRepository.insertEvent(connection, { conversationId: row.conversation_id, actorId: row.caller_id, type: 'call', data, at });
      await conversationRepository.setLastMessage(connection, { conversationId: row.conversation_id, messageId: id, at });
      return id;
    });
    const message = await messageService.broadcastCopy(messageId);
    realtime.broadcastMessage({ message, participantIds: await conversationRepository.listParticipantIds(row.conversation_id) });
  },

  /** A participant's tab went away: the host role moves on now; they are dropped after the grace period. */
  tabDisconnected(userId, tabId) {
    const call = live.get(callOfUser.get(userId));
    const p = call?.participants.get(userId);
    if (!p || p.tabId !== tabId || realtime.isTabConnected(userId, tabId)) return;
    if (call.hostId === userId) passHost(call);
    clearTimeout(call.graceTimers.get(userId));
    call.graceTimers.set(
      userId,
      setTimeout(() => {
        if (realtime.isTabConnected(userId, tabId)) return;
        this.leave(userId, call.id).catch((error) => logger.error('Group call cleanup failed', { callId: call.id, error }));
      }, config.calls.reconnectGraceMs),
    );
  },

  /** A participant's tab is back within the grace period. */
  tabConnected(socket) {
    const { user, tabId } = socket.data;
    const call = live.get(callOfUser.get(user.id));
    const p = call?.participants.get(user.id);
    if (!p || p.tabId !== tabId) return;
    clearTimeout(call.graceTimers.get(user.id));
    call.graceTimers.delete(user.id);
    if (!isConnected(call, call.hostId)) passHost(call);
    socket.emit('groupcall:resumed', { callId: call.id, hostId: call.hostId, call: toPayload(call) });
  },

  forget(call) {
    clearTimeout(call.ringTimer);
    for (const timer of call.graceTimers.values()) clearTimeout(timer);
    live.delete(call.id);
    if (callOfGroup.get(call.conversationId) === call.id) callOfGroup.delete(call.conversationId);
    for (const userId of call.participants.keys()) {
      if (callOfUser.get(userId) === call.id) callOfUser.delete(userId);
    }
  },
};
