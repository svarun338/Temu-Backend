import { z } from 'zod';
import { config } from '../config/index.js';
import { isBuiltinSticker } from '../utils/stickers.js';
import { cleanText } from '../utils/text.js';

/** Positive database id. Accepts numeric strings (route params / query strings). */
export const id = z.coerce
  .number({ error: 'Must be a number' })
  .int('Must be an integer')
  .positive('Must be a positive id')
  .max(Number.MAX_SAFE_INTEGER);

const email = z
  .string({ error: 'Email is required' })
  .trim()
  .toLowerCase()
  .max(255, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

const password = z
  .string({ error: 'Password is required' })
  .min(8, 'Password must be at least 8 characters')
  // bcrypt only uses the first 72 bytes, so refuse anything longer.
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes')
  .refine((value) => /[A-Za-z]/.test(value) && /\d/.test(value), 'Password must contain a letter and a number');

const name = z
  .string({ error: 'Name is required' })
  .transform(cleanText)
  .pipe(z.string().min(2, 'Name must be at least 2 characters').max(80, 'Name must be at most 80 characters'));

const otpCode = z
  .string({ error: 'Code is required' })
  .trim()
  .regex(new RegExp(`^\\d{${config.otp.length}}$`), `Enter the ${config.otp.length}-digit code`);

/** Optional free text: trimmed, control characters removed, empty → null. */
const optionalText = (max, label) =>
  z
    .string()
    .transform(cleanText)
    .pipe(z.string().max(max, `${label} must be at most ${max} characters`))
    .transform((value) => value || null)
    .nullable();

const messageBody = z
  .string({ error: 'Message is required' })
  .transform(cleanText)
  .pipe(
    z
      .string()
      .min(1, 'Message cannot be empty')
      .max(config.chat.maxMessageLength, `Message must be at most ${config.chat.maxMessageLength} characters`),
  );

const clientId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/, 'Invalid client id')
  .optional();

/** Text of a message that may carry attachments (then the text is an optional caption). */
const caption = z
  .string()
  .transform(cleanText)
  .pipe(z.string().max(config.chat.maxMessageLength, `Message must be at most ${config.chat.maxMessageLength} characters`))
  .default('');

const attachmentIds = z
  .array(id)
  .max(config.uploads.maxAttachmentsPerMessage, `You can send at most ${config.uploads.maxAttachmentsPerMessage} files at once`)
  .default([]);

const coordinates = {
  latitude: z.number({ error: 'Latitude is required' }).min(-90).max(90),
  longitude: z.number({ error: 'Longitude is required' }).min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).transform(Math.round).optional(),
};

/** A shared location; `liveMinutes` makes it a live location (15 min, 1 h or 8 h). */
const location = z
  .object({
    ...coordinates,
    liveMinutes: z.union([z.literal(15), z.literal(60), z.literal(480)], { error: 'Choose 15 minutes, 1 hour or 8 hours' }).optional(),
  })
  .optional();

/** Either some text, at least one attachment, or a location. */
// ---- End-to-end encryption: shapes and sizes only (the server can't read the content) ----
const b64 = (min, max) => z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/, 'Invalid encoding').min(min).max(max);
const MAX_CIPHERTEXT = Math.ceil(((config.chat.maxMessageLength * 4 + 16_000) * 4) / 3);

/** The content's ciphertext plus its key wrapped once per device that may read it. */
const encryptedPayload = z.object({
  ciphertext: b64(4, MAX_CIPHERTEXT),
  iv: b64(16, 16), // 12 bytes
  senderDeviceId: id,
  keys: z
    .array(z.object({ deviceId: id, wrapped: b64(40, 80), salt: b64(24, 24), iv: b64(16, 16) }))
    .min(1)
    .max(2_600), // 256 members × 10 devices
});

/** A live location whose positions are encrypted (static locations live inside the message). */
const encryptedLocation = z
  .object({
    ciphertext: b64(4, 400),
    iv: b64(16, 16),
    liveMinutes: z.union([z.literal(15), z.literal(60), z.literal(480)], { error: 'Choose 15 minutes, 1 hour or 8 hours' }),
  })
  .optional();

const e2eeExtras = {
  encrypted: encryptedPayload.optional(),
  encryptedLocation,
  forwardFrom: id.optional(),
  mentions: z.array(id).max(256).default([]),
};

/** A built-in sticker; it is the whole message (no text, files or location with it). */
const sticker = z.string().refine(isBuiltinSticker, 'Unknown sticker');

const newMessage = (shape) =>
  z
    .object({ body: caption, attachmentIds, location, sticker: sticker.optional(), ...e2eeExtras, ...shape })
    .refine((m) => m.body.length > 0 || m.attachmentIds.length > 0 || m.location || m.sticker || m.encrypted || m.forwardFrom, {
      message: 'Message cannot be empty',
      path: ['body'],
    })
    .refine((m) => !m.sticker || (!m.body && m.attachmentIds.length === 0 && !m.location), {
      message: 'A sticker is sent on its own',
      path: ['sticker'],
    });

const groupName = z
  .string({ error: 'Group name is required' })
  .transform(cleanText)
  .pipe(z.string().min(1, 'Group name is required').max(80, 'Group name must be at most 80 characters'));

/** "preset:<name>" or "custom:<id>"; null means "use the default". Ownership is checked in the service. */
const wallpaper = z
  .string()
  .regex(/^(preset:[a-z]{2,20}|custom:\d{1,18})$/, 'Choose one of the available wallpapers')
  .nullable();

/** Optional numeric multipart field ("" counts as missing). */
const optionalInt = (min, max) =>
  z.preprocess((v) => (v === '' || v == null ? undefined : v), z.coerce.number().int().min(min).max(max).optional());

const graphemes = new Intl.Segmenter('en', { granularity: 'grapheme' });
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[#*0-9]️?⃣)/u;

/** Exactly one emoji (including skin tones, ZWJ sequences and flags) — nothing else. */
const emoji = z
  .string({ error: 'Emoji is required' })
  .max(32, 'Invalid emoji')
  .refine((value) => [...graphemes.segment(value)].length === 1 && EMOJI.test(value), 'Send a single emoji');

/** One WebRTC signalling message: offer/answer, ICE candidate, or my mic/camera/screen state. */
const callSignalData = z.discriminatedUnion('type', [
  z.object({ type: z.enum(['offer', 'answer']), sdp: z.string().min(1).max(30_000) }),
  z.object({
    type: z.literal('candidate'),
    candidate: z.object({
      candidate: z.string().max(1_000),
      sdpMid: z.string().max(64).nullish(),
      sdpMLineIndex: z.number().int().min(0).max(64).nullish(),
      usernameFragment: z.string().max(256).nullish(),
    }),
  }),
  // My microphone / camera / screen-sharing state, so the other side can show "muted" / "camera off" / "sharing".
  z.object({ type: z.literal('state'), audio: z.boolean(), video: z.boolean(), screen: z.boolean().optional() }),
]);

export const schemas = {
  register: z.object({ name, email, password }),
  login: z.object({
    email,
    password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(200),
  }),
  verifyEmail: z.object({ email, code: otpCode }),
  emailOnly: z.object({ email }),
  resetPassword: z.object({ email, code: otpCode, password }),
  updateProfile: z
    .object({
      name: name.optional(),
      about: optionalText(140, 'About').optional(),
      status: z.enum(['available', 'busy', 'away', 'dnd'], { error: 'Choose a valid status' }).optional(),
    })
    .refine((data) => Object.values(data).some((value) => value !== undefined), 'Nothing to update'),
  userParam: z.object({ userId: id }),
  blockUser: z.object({ userId: id }),
  idParam: z.object({ id }),
  userSearch: z.object({
    q: z.string({ error: 'Search query is required' }).trim().min(2, 'Type at least 2 characters').max(100),
  }),
  addContact: z.object({ userId: id }),
  contactParam: z.object({ userId: id }),
  createConversation: z.object({ userId: id }),
  listMessages: z
    .object({
      before: id.optional(),
      after: id.optional(),
      limit: z.coerce.number().int().min(1).max(100).optional(),
    })
    .refine((query) => !(query.before && query.after), 'Use either "before" or "after", not both'),
  sendMessage: newMessage({ clientId, replyToId: id.optional() }),
  uploadAttachment: z.object({
    conversationId: id,
    kind: z.enum(['image', 'video', 'voice', 'audio', 'file', 'sticker']).optional(),
    // Encrypted on the device: the server stores opaque bytes and can't check the type.
    encrypted: z.enum(['true', 'false']).optional(),
    width: optionalInt(1, 20_000),
    height: optionalInt(1, 20_000),
    durationMs: optionalInt(0, 6 * 60 * 60 * 1000),
    pageCount: optionalInt(1, 65_535),
  }),
  attachmentParam: z.object({ attachmentId: id }),
  newSticker: z.object({ width: optionalInt(1, 4096), height: optionalInt(1, 4096) }),
  stickerSave: z.object({ attachmentId: id }),
  stickerSend: z.object({ conversationId: id }),
  gifTrending: z.object({ offset: z.coerce.number().int().min(0).max(4999).default(0) }),
  gifSearch: z.object({
    q: z.string().transform(cleanText).pipe(z.string().min(1, 'Type something to search').max(50, 'Search is too long')),
    offset: z.coerce.number().int().min(0).max(4999).default(0),
  }),
  gifAttach: z.object({ conversationId: id, gifId: z.string().regex(/^[A-Za-z0-9]{5,40}$/, 'Invalid GIF') }),
  gifReuse: z.object({ conversationId: id, attachmentId: id }),
  deleteAccount: z.object({ password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(200) }),
  updateSettings: z
    .object({
      notificationsEnabled: z.boolean().optional(),
      messagePreview: z.boolean().optional(),
      soundEnabled: z.boolean().optional(),
      privacy: z.object({ lastSeen: z.enum(['everyone', 'contacts', 'nobody']).optional() }).optional(),
      appearance: z
        .object({
          theme: z.enum(['system', 'light', 'dark']).optional(),
          accent: z.enum(['indigo', 'emerald', 'rose', 'amber', 'sky', 'violet', 'teal']).optional(),
          fontSize: z.enum(['small', 'medium', 'large']).optional(),
          bubbleStyle: z.enum(['rounded', 'soft', 'square']).optional(),
          defaultWallpaper: wallpaper.optional(),
        })
        .optional(),
    })
    .refine(
      (data) =>
        Object.entries(data).some(
          ([key, value]) => value !== undefined && (!['appearance', 'privacy'].includes(key) || Object.values(value).some((v) => v !== undefined)),
        ),
      'Nothing to update',
    ),
  chatWallpaper: z.object({ wallpaper }),
  createGroup: z.object({
    name: groupName,
    description: optionalText(500, 'Description').optional(),
    memberIds: z.array(id, { error: 'Choose people to add' }).min(1, 'Add at least one person').max(255),
  }),
  updateGroup: z
    .object({
      name: groupName.optional(),
      description: optionalText(500, 'Description').optional(),
      sendPermission: z.enum(['all', 'admins']).optional(),
      editPermission: z.enum(['all', 'admins']).optional(),
    })
    .refine((data) => Object.values(data).some((value) => value !== undefined), 'Nothing to update'),
  groupMembers: z.object({ userIds: z.array(id).min(1, 'Choose people to add').max(50) }),
  groupMemberParam: z.object({ id, userId: id }),
  memberRole: z.object({ role: z.enum(['admin', 'member']) }),
  inviteParam: z.object({ code: z.string().regex(/^[A-Za-z0-9_-]{22}$/, 'Invalid invite link') }),
  wallpaperParam: z.object({ wallpaperId: id }),
  muteConversation: z.object({ duration: z.enum(['8h', '1w', 'always'], { error: 'Choose 8 hours, 1 week or always' }) }),
  pushSubscription: z.object({
    endpoint: z.url({ protocol: /^https$/, error: 'Invalid push endpoint' }).max(1024),
    keys: z.object({
      p256dh: z.string().regex(/^[A-Za-z0-9_-]+=*$/).max(255),
      auth: z.string().regex(/^[A-Za-z0-9_-]+=*$/).max(255),
    }),
  }),
  pushEndpoint: z.object({ endpoint: z.string().max(1024) }),
  listNotifications: z.object({ before: id.optional(), limit: z.coerce.number().int().min(1).max(100).optional() }),
  markNotificationsRead: z.object({ ids: z.array(id).max(100).optional() }),
  updateLocation: z.union([z.object(coordinates), z.object({ ciphertext: b64(4, 400), iv: b64(16, 16) })]),
  socketLocationUpdate: z.union([
    z.object({ messageId: id, ...coordinates }),
    z.object({ messageId: id, ciphertext: b64(4, 400), iv: b64(16, 16) }),
  ]),
  socketLocationStop: z.object({ messageId: id }),
  download: z.object({ download: z.enum(['0', '1']).optional() }),
  gallery: z.object({
    type: z.enum(['media', 'files', 'audio'], { error: 'Choose media, files or audio' }),
    before: id.optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
  markRead: z.object({ messageId: id.optional() }),
  messageParam: z.object({ messageId: id }),
  editMessage: z.union([z.object({ body: messageBody }), z.object({ encrypted: encryptedPayload })]),
  messageBatch: z.object({
    ids: z
      .string()
      .regex(/^\d+(,\d+){0,99}$/, 'Up to 100 message ids, comma-separated')
      .transform((value) => value.split(',').map(Number)),
  }),
  registerDevice: z.object({
    publicKey: b64(88, 88), // 65-byte raw P-256 key
    name: z.string().transform(cleanText).pipe(z.string().min(1).max(100)).default('Browser'),
  }),
  deleteMessage: z.object({ scope: z.enum(['me', 'everyone'], { error: 'Choose "me" or "everyone"' }) }),
  react: z.object({ emoji }),
  forwardMessage: z.object({
    conversationIds: z
      .array(id, { error: 'Choose at least one chat' })
      .min(1, 'Choose at least one chat')
      .max(config.chat.maxForwardTargets, `You can forward to at most ${config.chat.maxForwardTargets} chats`),
  }),
  searchMessages: z.object({
    q: z.string({ error: 'Search query is required' }).trim().min(2, 'Type at least 2 characters').max(100),
    conversationId: id.optional(),
  }),

  // Socket.IO payloads
  socketSend: newMessage({ conversationId: id, clientId, replyToId: id.optional() }),
  startRecording: z.object({
    kind: z.enum(['audio', 'video'], { error: 'Choose audio or video' }),
    mimeType: z.string().trim().min(1).max(100),
  }),
  recordingParam: z.object({ recordingId: id }),
  recordingChunkParam: z.object({ recordingId: id, seq: z.coerce.number().int().min(0).max(100_000) }),
  finishRecording: z.object({ durationMs: z.number().int().min(0).max(4 * 60 * 60 * 1000).optional() }),
  callHistory: z.object({ before: id.optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }),
  hideCalls: z.object({ callIds: z.array(id).min(1).max(200).optional(), all: z.literal(true).optional() })
    .refine((v) => Boolean(v.callIds) !== Boolean(v.all), 'Send either callIds or all: true'),
  socketConversation: z.object({ conversationId: id }),
  socketCallStart: z.object({ conversationId: id, type: z.enum(['voice', 'video']) }),
  socketCall: z.object({ callId: id }),
  // WebRTC signalling, relayed as-is to the other party (only shapes and sizes are checked).
  socketCallSignal: z.object({ callId: id, data: callSignalData }),
  // Group calls: the same signalling, to one other participant named by `to`.
  socketGroupCallSignal: z.object({ callId: id, to: id, data: callSignalData }),
  socketTyping: z.object({ conversationId: id, activity: z.enum(['typing', 'recording']).default('typing') }),
  socketReceipt: z.object({ conversationId: id, messageId: id.optional() }),
};

/** Turn a ZodError into a client-friendly list of { field, message }. */
export function formatIssues(error) {
  return error.issues.map((issue) => ({
    field: issue.path.join('.') || undefined,
    message: issue.message,
  }));
}
