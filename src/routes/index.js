import express, { Router } from 'express';
import { config } from '../config/index.js';
import { authController } from '../controllers/authController.js';
import { blockController } from '../controllers/blockController.js';
import { contactController } from '../controllers/contactController.js';
import { conversationController } from '../controllers/conversationController.js';
import { messageController } from '../controllers/messageController.js';
import { profileController } from '../controllers/profileController.js';
import { settingsController } from '../controllers/settingsController.js';
import { userController } from '../controllers/userController.js';
import { appearanceController } from '../controllers/appearanceController.js';
import { attachmentController } from '../controllers/attachmentController.js';
import { accountController } from '../controllers/accountController.js';
import { callController } from '../controllers/callController.js';
import { e2eeController } from '../controllers/e2eeController.js';
import { gifController } from '../controllers/gifController.js';
import { stickerController } from '../controllers/stickerController.js';
import { groupController } from '../controllers/groupController.js';
import { recordingController } from '../controllers/recordingController.js';
import { authenticate, authenticateMedia } from '../middleware/authenticate.js';
import { rateLimiters, requireXhr } from '../middleware/security.js';
import { attachmentUpload, avatarUpload, stickerUpload, wallpaperUpload } from '../middleware/upload.js';
import { validate } from '../middleware/validate.js';
import { schemas } from '../validation/schemas.js';

function authRoutes() {
  const router = Router();
  router.post('/register', rateLimiters.register, validate({ body: schemas.register }), authController.register);
  router.post('/login', rateLimiters.login, validate({ body: schemas.login }), authController.login);
  router.post('/verify-email', rateLimiters.otpVerify, validate({ body: schemas.verifyEmail }), authController.verifyEmail);
  router.post('/resend-verification', rateLimiters.otpSend, validate({ body: schemas.emailOnly }), authController.resendVerification);
  router.post('/forgot-password', rateLimiters.otpSend, validate({ body: schemas.emailOnly }), authController.forgotPassword);
  router.post('/reset-password', rateLimiters.otpVerify, validate({ body: schemas.resetPassword }), authController.resetPassword);
  router.post('/refresh', rateLimiters.refresh, requireXhr, authController.refresh);
  router.post('/logout', requireXhr, authController.logout);
  router.post('/logout-all', authenticate, authController.logoutAll);
  router.get('/me', authenticate, authController.me);
  return router;
}

function userRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/search', rateLimiters.search, validate({ query: schemas.userSearch }), userController.search);
  router.get('/:userId', validate({ params: schemas.userParam }), userController.get);
  return router;
}

function profileRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/', profileController.get);
  router.patch('/', validate({ body: schemas.updateProfile }), profileController.update);
  router.put('/avatar', rateLimiters.upload, avatarUpload, profileController.setAvatar);
  router.delete('/avatar', profileController.removeAvatar);
  router.get('/export', rateLimiters.messageActions, accountController.exportData);
  // Password-checked like a sign-in, so it gets the same brute-force limit.
  router.post('/delete', rateLimiters.login, validate({ body: schemas.deleteAccount }), accountController.deleteAccount);
  return router;
}

function blockRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/', blockController.list);
  router.post('/', validate({ body: schemas.blockUser }), blockController.block);
  router.delete('/:userId', validate({ params: schemas.userParam }), blockController.unblock);
  return router;
}

function contactRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/', contactController.list);
  router.post('/', validate({ body: schemas.addContact }), contactController.add);
  router.delete('/:userId', validate({ params: schemas.contactParam }), contactController.remove);
  return router;
}

function conversationRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/', conversationController.list);
  router.post('/', validate({ body: schemas.createConversation }), conversationController.open);
  router.get('/:id', validate({ params: schemas.idParam }), conversationController.get);
  router.get(
    '/:id/messages',
    validate({ params: schemas.idParam, query: schemas.listMessages }),
    conversationController.listMessages,
  );
  router.post(
    '/:id/messages',
    rateLimiters.messages,
    validate({ params: schemas.idParam, body: schemas.sendMessage }),
    conversationController.sendMessage,
  );
  router.post('/:id/read', validate({ params: schemas.idParam, body: schemas.markRead }), conversationController.markRead);
  router.get('/:id/pins', validate({ params: schemas.idParam }), conversationController.listPins);
  router.get('/:id/attachments', validate({ params: schemas.idParam, query: schemas.gallery }), attachmentController.gallery);
  router.put('/:id/mute', validate({ params: schemas.idParam, body: schemas.muteConversation }), conversationController.mute);
  router.put('/:id/wallpaper', validate({ params: schemas.idParam, body: schemas.chatWallpaper }), appearanceController.setChatWallpaper);
  router.delete('/:id/mute', validate({ params: schemas.idParam }), conversationController.unmute);
  return router;
}

function groupRoutes() {
  const router = Router();
  router.use(authenticate);
  const group = validate({ params: schemas.idParam });
  const member = validate({ params: schemas.groupMemberParam });
  const invite = validate({ params: schemas.inviteParam });
  const limited = rateLimiters.messageActions;

  router.post('/', limited, validate({ body: schemas.createGroup }), groupController.create);
  // Invite links (before "/:id" so "invites" is never read as an id).
  router.get('/invites/:code', invite, groupController.previewInvite);
  router.post('/invites/:code/join', limited, invite, groupController.join);

  router.get('/:id', group, groupController.get);
  router.patch('/:id', limited, validate({ params: schemas.idParam, body: schemas.updateGroup }), groupController.update);
  router.put('/:id/avatar', rateLimiters.upload, group, avatarUpload, groupController.setAvatar);
  router.delete('/:id/avatar', limited, group, groupController.removeAvatar);
  router.post('/:id/members', limited, validate({ params: schemas.idParam, body: schemas.groupMembers }), groupController.addMembers);
  router.delete('/:id/members/:userId', limited, member, groupController.removeMember);
  router.patch('/:id/members/:userId', limited, validate({ params: schemas.groupMemberParam, body: schemas.memberRole }), groupController.setRole);
  router.post('/:id/leave', limited, group, groupController.leave);
  router.post('/:id/invite', limited, group, groupController.createInvite);
  router.delete('/:id/invite', limited, group, groupController.revokeInvite);
  return router;
}

/** GIF picker: search/trending via GIPHY (server-side key), recent GIFs, and attaching one to send. */
function gifRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/trending', rateLimiters.search, validate({ query: schemas.gifTrending }), gifController.trending);
  router.get('/search', rateLimiters.search, validate({ query: schemas.gifSearch }), gifController.search);
  router.get('/recent', gifController.recent);
  router.post('/', rateLimiters.attachmentUpload, validate({ body: schemas.gifAttach }), gifController.attach);
  router.post('/reuse', rateLimiters.attachmentUpload, validate({ body: schemas.gifReuse }), gifController.reuse);
  return router;
}

/** My stickers: list, make from an image, save one from a chat, remove, and ready one to send. */
function stickerRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/', stickerController.list);
  router.post('/', rateLimiters.upload, stickerUpload, stickerController.create);
  router.post('/save', rateLimiters.messageActions, validate({ body: schemas.stickerSave }), stickerController.save);
  router.delete('/:id', rateLimiters.messageActions, validate({ params: schemas.idParam }), stickerController.remove);
  router.post('/:id/send', rateLimiters.attachmentUpload, validate({ params: schemas.idParam, body: schemas.stickerSend }), stickerController.prepare);
  return router;
}

/** End-to-end encryption: my devices' public keys, and the devices to encrypt a chat's messages for. */
function e2eeRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/devices', e2eeController.listDevices);
  router.post('/devices', rateLimiters.messageActions, validate({ body: schemas.registerDevice }), e2eeController.registerDevice);
  router.delete('/devices/:id', rateLimiters.messageActions, validate({ params: schemas.idParam }), e2eeController.revokeDevice);
  router.get('/conversations/:id/devices', validate({ params: schemas.idParam }), e2eeController.conversationDevices);
  router.get('/users/:id/devices', validate({ params: schemas.idParam }), e2eeController.userDevices);
  return router;
}

/** Call history. Calls themselves are placed and signalled over Socket.IO. */
function callRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/', validate({ query: schemas.callHistory }), callController.history);
  router.post('/hide', rateLimiters.messageActions, validate({ body: schemas.hideCalls }), callController.hide);
  router.get('/ice-servers', callController.iceServers);
  router.get('/active', callController.active);
  router.get('/:id/recordings', validate({ params: schemas.idParam }), recordingController.listForCall);
  router.post('/:id/recordings', rateLimiters.recordings, validate({ params: schemas.idParam, body: schemas.startRecording }), recordingController.start);
  return router;
}

/** Call recordings: the browser uploads chunks while recording, then finishes. Playback is under /attachments. */
function recordingRoutes() {
  const router = Router();
  router.use(authenticate);
  router.put(
    '/:recordingId/chunks/:seq',
    rateLimiters.recordings,
    validate({ params: schemas.recordingChunkParam }),
    express.raw({ type: 'application/octet-stream', limit: config.recordings.maxChunkBytes }),
    recordingController.appendChunk,
  );
  router.post(
    '/:recordingId/finish',
    rateLimiters.recordings,
    validate({ params: schemas.recordingParam, body: schemas.finishRecording }),
    recordingController.finish,
  );
  router.delete('/:recordingId', rateLimiters.messageActions, validate({ params: schemas.recordingParam }), recordingController.remove);
  return router;
}

/** /settings, /notifications and /push (all signed-in only). */
function settingsRoutes() {
  const router = Router();
  router.get('/settings', authenticate, settingsController.get);
  router.get('/wallpapers', authenticate, appearanceController.listWallpapers);
  router.post('/wallpapers', authenticate, rateLimiters.upload, wallpaperUpload, appearanceController.uploadWallpaper);
  router.delete('/wallpapers/:wallpaperId', authenticate, validate({ params: schemas.wallpaperParam }), appearanceController.deleteWallpaper);
  router.patch('/settings', authenticate, validate({ body: schemas.updateSettings }), settingsController.update);
  router.get('/notifications', authenticate, validate({ query: schemas.listNotifications }), settingsController.listNotifications);
  router.post('/notifications/read', authenticate, validate({ body: schemas.markNotificationsRead }), settingsController.markNotificationsRead);
  router.post('/push/subscriptions', authenticate, rateLimiters.messageActions, validate({ body: schemas.pushSubscription }), settingsController.subscribePush);
  router.delete('/push/subscriptions', authenticate, validate({ body: schemas.pushEndpoint }), settingsController.unsubscribePush);
  return router;
}

function attachmentRoutes() {
  const router = Router();
  // Upload: bearer token only (state-changing, so the cookie is not accepted).
  router.post('/', authenticate, rateLimiters.attachmentUpload, attachmentUpload, attachmentController.upload);
  // Downloads: bearer token or the media cookie (for <img>/<video>/<audio>).
  const one = validate({ params: schemas.attachmentParam, query: schemas.download });
  // My stickers' images live here so the media cookie (path /api/attachments) covers them.
  // Call recordings too (bearer token or media cookie), streamed from local disk or S3.
  router.get('/recordings/:recordingId', authenticateMedia, validate({ params: schemas.recordingParam, query: schemas.download }), recordingController.download);
  router.get('/stickers/:id', authenticateMedia, validate({ params: schemas.idParam, query: schemas.download }), stickerController.image);
  router.get('/:attachmentId', authenticateMedia, one, attachmentController.download);
  router.get('/:attachmentId/thumbnail', authenticateMedia, one, attachmentController.thumbnail);
  return router;
}

function messageRoutes() {
  const router = Router();
  router.use(authenticate);
  router.get('/search', rateLimiters.search, validate({ query: schemas.searchMessages }), messageController.search);
  router.get('/batch', validate({ query: schemas.messageBatch }), messageController.batch);
  router.get('/starred', messageController.listStarred);
  router.get('/live-locations', messageController.listLiveLocations);

  const one = validate({ params: schemas.messageParam });
  const limited = rateLimiters.messageActions;
  router.patch('/:messageId', limited, validate({ params: schemas.messageParam, body: schemas.editMessage }), messageController.edit);
  router.delete('/:messageId', limited, validate({ params: schemas.messageParam, query: schemas.deleteMessage }), messageController.remove);
  router.put('/:messageId/reaction', limited, validate({ params: schemas.messageParam, body: schemas.react }), messageController.react);
  router.delete('/:messageId/reaction', limited, one, messageController.unreact);
  router.put('/:messageId/star', limited, one, messageController.star);
  router.delete('/:messageId/star', limited, one, messageController.unstar);
  router.put('/:messageId/pin', limited, one, messageController.pin);
  router.delete('/:messageId/pin', limited, one, messageController.unpin);
  router.patch(
    '/:messageId/location',
    limited,
    validate({ params: schemas.messageParam, body: schemas.updateLocation }),
    messageController.updateLocation,
  );
  router.delete('/:messageId/location/live', limited, one, messageController.stopLocation);
  router.post(
    '/:messageId/forward',
    rateLimiters.messages,
    validate({ params: schemas.messageParam, body: schemas.forwardMessage }),
    messageController.forward,
  );
  return router;
}

export function apiRouter() {
  const router = Router();
  router.get('/health', (_req, res) => res.json({ status: 'ok' }));
  router.use('/auth', authRoutes());
  router.use('/users', userRoutes());
  router.use('/profile', profileRoutes());
  router.use('/blocks', blockRoutes());
  router.use('/contacts', contactRoutes());
  router.use('/conversations', conversationRoutes());
  router.use('/messages', messageRoutes());
  router.use('/attachments', attachmentRoutes());
  router.use('/groups', groupRoutes());
  router.use('/calls', callRoutes());
  router.use('/recordings', recordingRoutes());
  router.use('/e2ee', e2eeRoutes());
  router.use('/gifs', gifRoutes());
  router.use('/stickers', stickerRoutes());
  router.use(settingsRoutes());
  return router;
}
