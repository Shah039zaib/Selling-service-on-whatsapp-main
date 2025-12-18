import makeWASocket, {
  DisconnectReason,
  WASocket,
  proto,
  downloadMediaMessage,
  getContentType,
  WAMessage,
  BaileysEventMap,
  ConnectionState,
} from 'baileys';
import { Boom } from '@hapi/boom';
import * as qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import { EventEmitter } from 'events';
import crypto from 'crypto';
import { prisma } from '../config/database.js';
import { logger, createChildLogger } from '../utils/logger.js';
import { sleep, sanitizePhoneNumber, extractPhoneNumber } from '../utils/helpers.js';
import { withTimeout, TIMEOUT_CONSTANTS } from '../utils/timeout.js';
import {
  WhatsAppMessage,
  WhatsAppConnectionState,
  WhatsAppAccountStatus,
  MessageType,
} from '../types/index.js';
import { useDatabaseAuthState, clearDatabaseSession } from './session-storage.service.js';

interface WhatsAppInstance {
  socket: WASocket | null;
  accountId: string;
  status: WhatsAppAccountStatus;
  reconnectAttempts: number;
  lastActivity: Date;
}

export class WhatsAppService extends EventEmitter {
  private instances: Map<string, WhatsAppInstance> = new Map();
  private readonly maxReconnectAttempts = 5;
  private readonly reconnectDelay = 5000;
  private readonly messageQueue: Map<string, { message: string; timestamp: number }[]> = new Map();
  private readonly rateLimitWindow = 60000;
  private readonly maxMessagesPerWindow = 30;
  private isShuttingDown = false;

  // Memory safety limits
  private readonly MAX_INSTANCES = 100;
  private readonly MAX_QUEUE_RECIPIENTS = 10000;
  private readonly MAX_QUEUE_SIZE_PER_RECIPIENT = 100;
  private readonly QUEUE_CLEANUP_INTERVAL = 300000; // 5 minutes
  private queueCleanupTimer?: NodeJS.Timeout;

  constructor() {
    super();
    this.setMaxListeners(50); // Prevent EventEmitter warning
    this.startQueueCleanup();
  }

  private startQueueCleanup(): void {
    this.queueCleanupTimer = setInterval(() => {
      this.cleanupMessageQueues();
    }, this.QUEUE_CLEANUP_INTERVAL);
  }

  private cleanupMessageQueues(): void {
    const now = Date.now();
    let cleaned = 0;

    // Remove expired messages from queues
    for (const [recipient, queue] of this.messageQueue.entries()) {
      const activeMessages = queue.filter(
        (m) => now - m.timestamp < this.rateLimitWindow
      );

      if (activeMessages.length === 0) {
        this.messageQueue.delete(recipient);
        cleaned++;
      } else if (activeMessages.length < queue.length) {
        this.messageQueue.set(recipient, activeMessages);
      }
    }

    if (cleaned > 0) {
      logger.info({ cleaned }, 'Cleaned up expired message queues');
    }
  }

  async initializeAccount(accountId: string): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });

    if (this.instances.has(accountId)) {
      log.warn('Account already initialized, disconnecting first');
      await this.disconnectAccount(accountId);
    }

    // Check instance limit
    if (this.instances.size >= this.MAX_INSTANCES) {
      log.error({ currentSize: this.instances.size, limit: this.MAX_INSTANCES }, 'Instance limit reached');
      throw new Error(`Cannot initialize account: instance limit (${this.MAX_INSTANCES}) reached`);
    }

    const instance: WhatsAppInstance = {
      socket: null,
      accountId,
      status: 'CONNECTING',
      reconnectAttempts: 0,
      lastActivity: new Date(),
    };

    this.instances.set(accountId, instance);

    try {
      await this.connectAccount(accountId);
    } catch (error) {
      log.error({ error }, 'Failed to initialize WhatsApp account');
      await this.updateAccountStatus(accountId, 'DISCONNECTED');
      throw error;
    }
  }

  private async connectAccount(accountId: string): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    const instance = this.instances.get(accountId);

    if (!instance) {
      throw new Error('Account instance not found');
    }

    const { state, saveCreds } = await useDatabaseAuthState(accountId);

    const socket = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      browser: ['WhatsApp SaaS', 'Chrome', '120.0.0'],
      syncFullHistory: false,
      markOnlineOnConnect: true,
      generateHighQualityLinkPreview: false,
      getMessage: async (_key) => {
        return { conversation: '' };
      },
    });

    instance.socket = socket;

    socket.ev.on('creds.update', saveCreds);

    socket.ev.on('connection.update', async (update: Partial<ConnectionState>) => {
      await this.handleConnectionUpdate(accountId, update);
    });

    socket.ev.on('messages.upsert', async (data: BaileysEventMap['messages.upsert']) => {
      await this.handleIncomingMessages(accountId, data);
    });

    log.info('WhatsApp socket created, waiting for connection');
  }

  private async handleConnectionUpdate(
    accountId: string,
    update: Partial<ConnectionState>
  ): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    const instance = this.instances.get(accountId);

    if (!instance) return;

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log.info('QR code received');

      qrcodeTerminal.generate(qr, { small: true });

      const qrDataUrl = await qrcode.toDataURL(qr);

      await prisma.whatsAppAccount.update({
        where: { id: accountId },
        data: {
          qrCode: qrDataUrl,
          status: 'CONNECTING',
        },
      });

      this.emit('qr', { accountId, qrCode: qrDataUrl });
    }

    if (connection === 'close') {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      log.info({ statusCode, shouldReconnect }, 'Connection closed');

      if (statusCode === DisconnectReason.loggedOut) {
        await this.handleLoggedOut(accountId);
      } else if (shouldReconnect && !this.isShuttingDown) {
        await this.handleReconnect(accountId);
      } else {
        await this.updateAccountStatus(accountId, 'DISCONNECTED');
      }
    }

    if (connection === 'open') {
      log.info('Connection established');
      instance.status = 'CONNECTED';
      instance.reconnectAttempts = 0;
      instance.lastActivity = new Date();

      const phoneNumber = instance.socket?.user?.id
        ? extractPhoneNumber(instance.socket.user.id)
        : null;

      await prisma.whatsAppAccount.update({
        where: { id: accountId },
        data: {
          status: 'CONNECTED',
          phoneNumber,
          qrCode: null,
          lastConnected: new Date(),
        },
      });

      this.emit('connected', { accountId, phoneNumber });
    }
  }

  private async handleLoggedOut(accountId: string): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    log.warn('Account logged out, clearing session');

    try {
      await clearDatabaseSession(accountId);
    } catch (error) {
      log.error({ error }, 'Failed to clear session');
    }

    await this.updateAccountStatus(accountId, 'DISCONNECTED');
    this.instances.delete(accountId);

    this.emit('disconnected', { accountId, reason: 'logged_out' });
  }

  private async handleReconnect(accountId: string): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    const instance = this.instances.get(accountId);

    if (!instance) return;

    if (instance.reconnectAttempts >= this.maxReconnectAttempts) {
      log.error('Max reconnection attempts reached');
      await this.updateAccountStatus(accountId, 'DISCONNECTED');
      this.emit('disconnected', { accountId, reason: 'max_reconnect_attempts' });
      return;
    }

    instance.reconnectAttempts++;
    const delay = this.reconnectDelay * instance.reconnectAttempts;

    log.info({ attempt: instance.reconnectAttempts, delay }, 'Scheduling reconnection');

    await sleep(delay);

    if (!this.isShuttingDown && this.instances.has(accountId)) {
      try {
        await this.connectAccount(accountId);
      } catch (error) {
        log.error({ error }, 'Reconnection failed');
      }
    }
  }

  private async handleIncomingMessages(
    accountId: string,
    { messages, type }: BaileysEventMap['messages.upsert']
  ): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });

    if (type !== 'notify') return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      try {
        const whatsappMessage = await this.parseMessage(accountId, msg);

        if (whatsappMessage) {
          log.info(
            { from: whatsappMessage.from, type: whatsappMessage.type },
            'Received message'
          );

          this.emit('message', { accountId, message: whatsappMessage, rawMessage: msg });
        }
      } catch (error) {
        log.error({ error, messageId: msg.key.id }, 'Failed to process message');
      }
    }
  }

  private async parseMessage(
    accountId: string,
    msg: WAMessage
  ): Promise<WhatsAppMessage | null> {
    const messageContent = msg.message;
    if (!messageContent) return null;

    const from = msg.key.remoteJid;
    if (!from) return null;

    const isGroup = from.endsWith('@g.us');
    const contentType = getContentType(messageContent);

    let type: MessageType = 'TEXT';
    let content = '';
    let mediaUrl: string | undefined;

    switch (contentType) {
      case 'conversation':
        content = messageContent.conversation || '';
        break;

      case 'extendedTextMessage':
        content = messageContent.extendedTextMessage?.text || '';
        break;

      case 'imageMessage':
        type = 'IMAGE';
        content = messageContent.imageMessage?.caption || '[Image]';
        break;

      case 'videoMessage':
        type = 'VIDEO';
        content = messageContent.videoMessage?.caption || '[Video]';
        break;

      case 'audioMessage':
        type = 'AUDIO';
        content = '[Audio message]';
        break;

      case 'documentMessage':
        type = 'DOCUMENT';
        content = messageContent.documentMessage?.fileName || '[Document]';
        break;

      case 'stickerMessage':
        type = 'STICKER';
        content = '[Sticker]';
        break;

      case 'locationMessage':
        type = 'LOCATION';
        const loc = messageContent.locationMessage;
        content = loc
          ? `[Location: ${loc.degreesLatitude}, ${loc.degreesLongitude}]`
          : '[Location]';
        break;

      case 'contactMessage':
        type = 'CONTACT';
        content = messageContent.contactMessage?.displayName || '[Contact]';
        break;

      default:
        content = '[Unsupported message type]';
    }

    return {
      id: msg.key.id || crypto.randomUUID(),
      from: extractPhoneNumber(from),
      to: accountId,
      type,
      content,
      mediaUrl,
      timestamp: new Date(
        msg.messageTimestamp
          ? typeof msg.messageTimestamp === 'number'
            ? msg.messageTimestamp * 1000
            : Number(msg.messageTimestamp) * 1000
          : Date.now()
      ),
      isGroup,
      pushName: msg.pushName || undefined,
    };
  }

  async downloadMedia(
    accountId: string,
    msg: WAMessage
  ): Promise<Buffer | null> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    const instance = this.instances.get(accountId);

    if (!instance?.socket) {
      log.error('Account not connected');
      return null;
    }

    try {
      // Wrap media download with timeout to prevent hanging
      const buffer = await withTimeout(
        downloadMediaMessage(
          msg,
          'buffer',
          {},
          {
            logger: log as any,
            reuploadRequest: instance.socket.updateMediaMessage,
          }
        ),
        TIMEOUT_CONSTANTS.MEDIA_DOWNLOAD,
        'whatsapp-download-media',
        {
          accountId,
          messageId: msg.key.id
        }
      );
      return buffer as Buffer;
    } catch (error) {
      log.error({ error }, 'Failed to download media');
      return null;
    }
  }

  async sendMessage(
    accountId: string,
    to: string,
    content: string,
    options?: {
      quotedMessageId?: string;
      mediaUrl?: string;
      mediaType?: 'image' | 'video' | 'audio' | 'document';
      filename?: string;
    }
  ): Promise<proto.WebMessageInfo | null> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    const instance = this.instances.get(accountId);

    if (!instance?.socket || instance.status !== 'CONNECTED') {
      log.error('Account not connected');
      throw new Error('WhatsApp account not connected');
    }

    if (!this.checkRateLimit(to)) {
      log.warn({ to }, 'Rate limit exceeded');
      throw new Error('Rate limit exceeded for this recipient');
    }

    const jid = sanitizePhoneNumber(to);

    try {
      await this.simulateTyping(instance.socket, jid);

      let message: any;

      if (options?.mediaUrl && options?.mediaType) {
        const mediaBuffer = await this.fetchMediaBuffer(options.mediaUrl);

        switch (options.mediaType) {
          case 'image':
            message = {
              image: mediaBuffer,
              caption: content || undefined,
            };
            break;
          case 'video':
            message = {
              video: mediaBuffer,
              caption: content || undefined,
            };
            break;
          case 'audio':
            message = {
              audio: mediaBuffer,
              mimetype: 'audio/mp4',
            };
            break;
          case 'document':
            message = {
              document: mediaBuffer,
              fileName: options.filename || 'document',
              caption: content || undefined,
            };
            break;
        }
      } else {
        message = { text: content };
      }

      // Wrap sendMessage with timeout to prevent hanging
      const result = await withTimeout(
        instance.socket.sendMessage(jid, message),
        TIMEOUT_CONSTANTS.WHATSAPP_SEND,
        'whatsapp-send-message',
        {
          accountId,
          to,
          messageType: options?.mediaType || 'text'
        }
      );

      this.recordMessage(to);
      instance.lastActivity = new Date();

      log.info({ to, messageId: result?.key?.id }, 'Message sent');

      return result ?? null;
    } catch (error) {
      log.error({ error, to }, 'Failed to send message');
      throw error;
    }
  }

  private async simulateTyping(socket: WASocket, jid: string): Promise<void> {
    try {
      await socket.presenceSubscribe(jid);
      await socket.sendPresenceUpdate('composing', jid);

      const typingDuration = Math.random() * 2000 + 1000;
      await sleep(typingDuration);

      await socket.sendPresenceUpdate('paused', jid);
    } catch {
    }
  }

  private async fetchMediaBuffer(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to fetch media: ${response.statusText}`);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  private checkRateLimit(recipient: string): boolean {
    const now = Date.now();
    const queue = this.messageQueue.get(recipient) || [];

    const recentMessages = queue.filter(
      (m) => now - m.timestamp < this.rateLimitWindow
    );

    this.messageQueue.set(recipient, recentMessages);

    return recentMessages.length < this.maxMessagesPerWindow;
  }

  private recordMessage(recipient: string): void {
    // Check total recipients limit
    if (!this.messageQueue.has(recipient) && this.messageQueue.size >= this.MAX_QUEUE_RECIPIENTS) {
      logger.warn({ size: this.messageQueue.size, limit: this.MAX_QUEUE_RECIPIENTS }, 'Message queue recipient limit reached, cleaning oldest');
      // Remove oldest entry (first in iterator)
      const firstKey = this.messageQueue.keys().next().value;
      if (firstKey) {
        this.messageQueue.delete(firstKey);
      }
    }

    const queue = this.messageQueue.get(recipient) || [];

    // Enforce per-recipient queue size limit
    if (queue.length >= this.MAX_QUEUE_SIZE_PER_RECIPIENT) {
      queue.shift(); // Remove oldest message
    }

    queue.push({ message: '', timestamp: Date.now() });
    this.messageQueue.set(recipient, queue);
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const log = createChildLogger({ accountId, service: 'whatsapp' });
    const instance = this.instances.get(accountId);

    if (!instance) {
      log.warn('Account not found');
      return;
    }

    try {
      if (instance.socket) {
        instance.socket.ev.removeAllListeners('connection.update');
        instance.socket.ev.removeAllListeners('creds.update');
        instance.socket.ev.removeAllListeners('messages.upsert');
        await instance.socket.logout().catch(() => {});
        instance.socket = null;
      }
    } catch (error) {
      log.error({ error }, 'Error during disconnect');
    }

    this.instances.delete(accountId);
    await this.updateAccountStatus(accountId, 'DISCONNECTED');

    log.info('Account disconnected');
    this.emit('disconnected', { accountId, reason: 'manual' });
  }

  private async updateAccountStatus(
    accountId: string,
    status: WhatsAppAccountStatus
  ): Promise<void> {
    try {
      await prisma.whatsAppAccount.update({
        where: { id: accountId },
        data: { status },
      });

      const instance = this.instances.get(accountId);
      if (instance) {
        instance.status = status;
      }
    } catch (error) {
      logger.error({ error, accountId }, 'Failed to update account status');
    }
  }

  getConnectionState(accountId: string): WhatsAppConnectionState | null {
    const instance = this.instances.get(accountId);
    if (!instance) return null;

    return {
      accountId,
      status: instance.status,
      phoneNumber: instance.socket?.user?.id
        ? extractPhoneNumber(instance.socket.user.id)
        : undefined,
      lastConnected: instance.lastActivity,
    };
  }

  getActiveAccounts(): string[] {
    return Array.from(this.instances.keys()).filter(
      (id) => this.instances.get(id)?.status === 'CONNECTED'
    );
  }

  async shutdown(): Promise<void> {
    logger.info('Shutting down WhatsApp service');
    this.isShuttingDown = true;

    // Clear cleanup timer
    if (this.queueCleanupTimer) {
      clearInterval(this.queueCleanupTimer);
      this.queueCleanupTimer = undefined;
    }

    const disconnectPromises = Array.from(this.instances.keys()).map((id) =>
      this.disconnectAccount(id)
    );

    await Promise.allSettled(disconnectPromises);

    this.instances.clear();
    this.messageQueue.clear();
    this.removeAllListeners(); // Clean up all EventEmitter listeners

    logger.info('WhatsApp service shutdown complete');
  }
}

export const whatsappService = new WhatsAppService();
