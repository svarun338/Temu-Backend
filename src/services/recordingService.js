import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config/index.js';
import { withTransaction } from '../db/pool.js';
import { callRepository } from '../repositories/callRepository.js';
import { conversationRepository } from '../repositories/conversationRepository.js';
import { messageRepository } from '../repositories/messageRepository.js';
import { recordingRepository } from '../repositories/recordingRepository.js';
import { realtime } from '../sockets/realtime.js';
import { AppError } from '../utils/AppError.js';
import { logger } from '../utils/logger.js';
import { addWebmDuration, webmDurationMs } from '../utils/webm.js';
import { TEMP_DIR } from './attachmentStorage.js';
import { callService } from './callService.js';
import { messageService } from './messageService.js';
import { objectStorage } from './objectStorage.js';

/**
 * Call recordings. Only the host of the call (who started it; after the host drops, the
 * next person who joined) may record. The host's browser mixes both sides and records it
 * (MediaRecorder); every few seconds it uploads the next chunk, which is appended to a
 * temp file here. When recording stops (or the call ends) the file goes to object
 * storage (S3 in production) and a "Call recording" note with a player appears in the
 * chat for everyone in it. The others in the call are told the moment recording starts and stops.
 *
 * Storage key: recordings/<yyyy>/<mm>/conversation-<id>/call-<id>/<recordingId>-<random>.<ext>
 */
const TYPES = {
  audio: { 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' },
  video: { 'video/webm': 'webm', 'video/mp4': 'mp4' },
};

const notFound = () => AppError.notFound('Recording not found');
const tempPath = (id) => path.join(TEMP_DIR, `recording-${id}.part`);

// One operation at a time per recording, so chunks are appended in order and never during finalizing.
const queues = new Map();
function serialized(id, task) {
  const run = (queues.get(id) ?? Promise.resolve()).then(task, task);
  const tail = run.catch(() => {});
  queues.set(id, tail);
  tail.then(() => queues.get(id) === tail && queues.delete(id));
  return run;
}

const finalizeTimers = new Map(); // recordingId -> timer, after its call ended

export function toRecording(row) {
  return {
    id: row.id,
    callId: row.call_id,
    conversationId: row.conversation_id,
    recorder: { id: row.recorder_id, name: row.recorder_name },
    kind: row.kind,
    mimeType: row.mime_type,
    status: row.status,
    sizeBytes: Number(row.size_bytes),
    durationMs: row.duration_ms,
    startedAt: new Date(row.started_at).toISOString(),
    // Under /api/attachments so the media cookie lets <audio>/<video> play it.
    url: `/api/attachments/recordings/${row.id}`,
  };
}

export function storageKeyFor(row) {
  const started = new Date(row.started_at);
  const yyyy = started.getUTCFullYear();
  const mm = String(started.getUTCMonth() + 1).padStart(2, '0');
  const ext = TYPES[row.kind][row.mime_type];
  const random = crypto.randomBytes(4).toString('hex');
  return `recordings/${yyyy}/${mm}/conversation-${row.conversation_id}/call-${row.call_id}/${row.id}-${random}.${ext}`;
}

/** Tell everyone else in the call (one-to-one or group) that recording started or stopped. */
function announce(row, recording) {
  const others = callService.participantsOf(row.call_id).filter((userId) => userId !== row.recorder_id);
  realtime.emitToUsers(others, 'call:recording', { callId: row.call_id, recordingId: row.id, userId: row.recorder_id, kind: row.kind, recording });
}

export const recordingService = {
  /** Start recording a connected call (either participant). Returns the recording. */
  async start(userId, callId, { kind, mimeType }) {
    const call = callService.ongoingCall(userId, callId);
    if (call.hostId !== userId) throw new AppError(403, 'NOT_HOST', 'Only the host of the call can record it');
    if (kind === 'video' && call.type !== 'video') throw AppError.badRequest('Voice calls can only be recorded as audio');
    const baseType = mimeType.split(';')[0].trim().toLowerCase();
    if (!TYPES[kind][baseType]) throw new AppError(415, 'UNSUPPORTED_FILE', 'This recording format is not supported');
    if (await recordingRepository.findActive(callId, userId)) throw new AppError(409, 'ALREADY_RECORDING', 'You are already recording this call');

    const id = await recordingRepository.insert({
      callId,
      conversationId: call.conversationId,
      recorderId: userId,
      kind,
      mimeType: baseType,
      startedAt: new Date(),
    });
    await fs.mkdir(TEMP_DIR, { recursive: true });
    await fs.writeFile(tempPath(id), '');
    const row = await recordingRepository.findById(id);
    await announce(row, true);
    return toRecording(row);
  },

  /**
   * Append chunk `seq` (0, 1, 2…). Re-sending a chunk that already arrived is fine (a retry
   * after a lost response); skipping ahead is refused so the file never has a gap.
   */
  appendChunk(userId, recordingId, seq, bytes) {
    return serialized(recordingId, async () => {
      const row = await recordingRepository.findById(recordingId);
      if (!row || row.recorder_id !== userId) throw notFound();
      if (row.status !== 'recording') throw new AppError(409, 'RECORDING_FINISHED', 'This recording has already been saved');
      if (seq < row.next_seq) return { nextSeq: row.next_seq, sizeBytes: Number(row.size_bytes) };
      if (seq > row.next_seq) {
        throw new AppError(409, 'CHUNK_OUT_OF_ORDER', `Expected chunk ${row.next_seq}`, { expected: row.next_seq });
      }
      if (!bytes?.length) throw AppError.badRequest('The chunk is empty');
      const sizeBytes = Number(row.size_bytes) + bytes.length;
      if (sizeBytes > config.recordings.maxBytes) {
        throw new AppError(413, 'RECORDING_TOO_LARGE', `Recordings can be up to ${Math.round(config.recordings.maxBytes / 1048576)} MB`);
      }
      await fs.appendFile(tempPath(recordingId), bytes);
      await recordingRepository.advance(recordingId, { nextSeq: seq + 1, sizeBytes });
      return { nextSeq: seq + 1, sizeBytes };
    });
  },

  /** The recorder stopped: store the file and post it in the chat. */
  async finish(userId, recordingId, { durationMs }) {
    const row = await recordingRepository.findById(recordingId);
    if (!row || row.recorder_id !== userId) throw notFound();
    return this.finalize(recordingId, durationMs);
  },

  /**
   * Move the temp file to object storage and announce it. Safe to call twice (the
   * second call returns the stored recording). An empty recording is discarded (null).
   */
  finalize(recordingId, durationMs) {
    return serialized(recordingId, async () => {
      clearTimeout(finalizeTimers.get(recordingId));
      finalizeTimers.delete(recordingId);
      const row = await recordingRepository.findById(recordingId);
      if (!row) throw notFound();
      if (row.status === 'ready') return toRecording(row);
      if (row.status === 'failed') throw new AppError(409, 'RECORDING_FAILED', 'This recording could not be saved');

      announce(row, false);
      const now = new Date();
      if (Number(row.size_bytes) === 0) {
        await recordingRepository.delete(recordingId);
        await fs.unlink(tempPath(recordingId)).catch(() => {});
        return null;
      }
      // Length: what the file really contains (later pieces may never have arrived, e.g. the
      // recorder's connection dropped); otherwise the browser's figure, never more than the time that passed.
      const elapsed = now - new Date(row.started_at);
      const webm = row.mime_type.endsWith('/webm');
      const inFile = webm ? await webmDurationMs(tempPath(recordingId)).catch(() => null) : null;
      const duration = Math.max(0, Math.min(inFile ?? durationMs ?? elapsed, elapsed + 10_000, config.recordings.maxDurationMs));

      // Browsers write WebM without its length: add it so players show the time and can seek.
      if (webm) {
        await addWebmDuration(tempPath(recordingId), duration).catch((error) => logger.warn('Could not add the recording length', { recordingId, error }));
      }
      const storage = objectStorage.current;
      const key = storageKeyFor(row);
      try {
        await storage.put(key, tempPath(recordingId), row.mime_type);
      } catch (error) {
        logger.error('Storing a call recording failed', { recordingId, error });
        await recordingRepository.markFailed(recordingId, now);
        throw new AppError(502, 'STORAGE_FAILED', 'The recording could not be saved. Please try again later.');
      }
      if (!(await recordingRepository.markReady(recordingId, { driver: storage.name, key, durationMs: duration, at: now }))) {
        await storage.remove(key).catch(() => {});
        return toRecording(await recordingRepository.findById(recordingId));
      }
      const saved = await recordingRepository.findById(recordingId);
      await this.postInChat(saved);
      return toRecording(saved);
    });
  },

  /** "Call recording · 2:31" with a player, from the recorder, for everyone in the chat. */
  async postInChat(row) {
    const at = new Date(row.finished_at);
    const data = {
      recordingId: row.id,
      callId: row.call_id,
      kind: row.kind,
      mimeType: row.mime_type,
      durationSec: Math.round(row.duration_ms / 1000),
      recorderId: row.recorder_id,
      url: toRecording(row).url,
    };
    const messageId = await withTransaction(async (connection) => {
      await conversationRepository.lockForUpdate(connection, row.conversation_id);
      const id = await messageRepository.insertEvent(connection, {
        conversationId: row.conversation_id,
        actorId: row.recorder_id,
        type: 'call_recording',
        data,
        at,
      });
      await conversationRepository.setLastMessage(connection, { conversationId: row.conversation_id, messageId: id, at });
      return id;
    });
    const message = await messageService.broadcastCopy(messageId);
    realtime.broadcastMessage({ message, participantIds: await conversationRepository.listParticipantIds(row.conversation_id) });
  },

  /** A call ended: recordings still open are saved once their last chunks had time to arrive. */
  async callEnded(callId) {
    for (const row of await recordingRepository.listActiveForCall(callId)) this.finalizeSoon(row.id);
  },

  /**
   * The host changed: the previous host's recording ends at this moment, the moment the others
   * are told it stopped. It is saved with what arrived so far, and pieces their browser sends
   * later (it may have kept capturing while their connection was gone) are refused, so nothing
   * said after "recording stopped" ends up in the file. The new host may record.
   */
  async hostChanged(callId, previousHostId) {
    for (const row of await recordingRepository.listActiveForCall(callId)) {
      if (row.recorder_id !== previousHostId) continue;
      announce(row, false);
      await this.finalize(row.id).catch((error) => logger.error('Saving a recording failed', { recordingId: row.id, error }));
    }
  },

  /** Save a recording after the grace period (its last chunks may still be on the way). */
  finalizeSoon(recordingId) {
    clearTimeout(finalizeTimers.get(recordingId));
    const timer = setTimeout(() => {
      finalizeTimers.delete(recordingId);
      this.finalize(recordingId).catch((error) => logger.error('Saving a recording failed', { recordingId, error }));
    }, config.recordings.finalizeGraceMs);
    timer.unref?.();
    finalizeTimers.set(recordingId, timer);
  },

  /** On startup: recordings interrupted by a restart are saved with what arrived. */
  async recoverInterrupted() {
    for (const row of await recordingRepository.listActive()) {
      await this.finalize(row.id).catch(async (error) => {
        logger.warn('Could not recover a recording', { recordingId: row.id, error });
        await recordingRepository.markFailed(row.id, new Date());
      });
    }
  },

  /** Where a participant of the chat can play or download a saved recording. */
  async getForDownload(userId, recordingId) {
    const row = await recordingRepository.findById(recordingId);
    if (!row || row.status !== 'ready') throw notFound();
    if (!(await conversationRepository.isParticipant(row.conversation_id, userId))) throw notFound();
    const date = new Date(row.started_at).toISOString().slice(0, 10);
    return {
      storage: objectStorage.driver(row.storage_driver),
      key: row.storage_key,
      size: Number(row.size_bytes),
      mimeType: row.mime_type,
      name: `call-recording-${date}-${row.id}.${TYPES[row.kind][row.mime_type]}`,
    };
  },

  /** Saved recordings of a call, for anyone in that chat (both people, or the group's members). */
  async listForCall(userId, callId) {
    const call = await callRepository.findById(callId);
    if (!call || !(await conversationRepository.isParticipant(call.conversation_id, userId))) throw AppError.notFound('Call not found');
    return (await recordingRepository.listReadyForCall(callId)).map(toRecording);
  },

  /** The recorder deletes their recording: the file is removed from storage for everyone. */
  async remove(userId, recordingId) {
    const row = await recordingRepository.findById(recordingId);
    if (!row || row.recorder_id !== userId) throw notFound();
    if (row.status === 'recording') throw new AppError(409, 'RECORDING_IN_PROGRESS', 'Stop the recording first');
    if (row.storage_key) await objectStorage.driver(row.storage_driver).remove(row.storage_key);
    await recordingRepository.delete(recordingId);
    const participantIds = await conversationRepository.listParticipantIds(row.conversation_id);
    realtime.emitToUsers(participantIds, 'recording:deleted', { recordingId, conversationId: row.conversation_id });
  },

  /** Account deletion: remove this user's recording files (the rows go with the account). */
  async removeAllBy(userId) {
    for (const row of await recordingRepository.listStoredBy(userId)) {
      await objectStorage
        .driver(row.storage_driver)
        .remove(row.storage_key)
        .catch((error) => logger.warn('Could not delete a recording file', { recordingId: row.id, error }));
    }
  },

  /** Tests: cancel pending saves. */
  reset() {
    for (const timer of finalizeTimers.values()) clearTimeout(timer);
    finalizeTimers.clear();
  },
};

callService.onCallEnded((call) => {
  recordingService.callEnded(call.id).catch((error) => logger.error('Wrapping up recordings failed', { callId: call.id, error }));
});
callService.onHostChanged(({ callId, previousHostId }) => {
  recordingService.hostChanged(callId, previousHostId).catch((error) => logger.error('Wrapping up recordings failed', { callId, error }));
});
