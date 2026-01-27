/**
 * DingTalk Channel Plugin for Clawdbot
 * 
 * 使用钉钉 Stream 模式连接，完整接入 Clawdbot 消息处理管道
 * 
 * 功能：
 * - 私聊和群聊支持
 * - 文本/图片/语音/文件消息
 * - 完整的 AI 对话流程
 * - Markdown 消息格式
 */

import { DWClient, TOPIC_ROBOT } from 'dingtalk-stream';
import axios from 'axios';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { ClawdbotPluginApi, PluginRuntime, ClawdbotConfig } from 'clawdbot/plugin-sdk';

// Plugin ID
export const id = 'dingtalk';

// Runtime reference
let runtime: PluginRuntime | null = null;

function getRuntime(): PluginRuntime {
  if (!runtime) {
    throw new Error('DingTalk runtime not initialized');
  }
  return runtime;
}

// Access Token cache
let accessToken: string | null = null;
let accessTokenExpiry = 0;

// Get channel config
function getConfig(cfg: ClawdbotConfig) {
  return (cfg?.channels as any)?.dingtalk || {};
}

// Check if configured
function isConfigured(cfg: ClawdbotConfig): boolean {
  const config = getConfig(cfg);
  return Boolean(config.clientId && config.clientSecret);
}

// Get Access Token
async function getAccessToken(config: any): Promise<string> {
  const now = Date.now();
  if (accessToken && accessTokenExpiry > now + 60000) {
    return accessToken;
  }

  const response = await axios.post('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    appKey: config.clientId,
    appSecret: config.clientSecret,
  });
  
  accessToken = response.data.accessToken;
  accessTokenExpiry = now + (response.data.expireIn * 1000);
  return accessToken!;
}

// Download media file from DingTalk
async function downloadMedia(config: any, downloadCode: string): Promise<{ path: string; mimeType: string } | null> {
  try {
    const token = await getAccessToken(config);
    
    // Get download URL
    const response = await axios.post(
      'https://api.dingtalk.com/v1.0/robot/messageFiles/download',
      { downloadCode, robotCode: config.robotCode },
      { headers: { 'x-acs-dingtalk-access-token': token } }
    );
    
    const downloadUrl = response.data?.downloadUrl;
    if (!downloadUrl) return null;
    
    // Download file
    const mediaResponse = await axios.get(downloadUrl, { responseType: 'arraybuffer' });
    const contentType = mediaResponse.headers['content-type'] || 'application/octet-stream';
    
    // Save to temp file
    const ext = contentType.split('/')[1]?.split(';')[0] || 'bin';
    const tempPath = path.join(os.tmpdir(), `dingtalk_${Date.now()}.${ext}`);
    fs.writeFileSync(tempPath, Buffer.from(mediaResponse.data));
    
    return { path: tempPath, mimeType: contentType };
  } catch (err: any) {
    console.error('[DingTalk] Failed to download media:', err.message);
    return null;
  }
}

// Extract text and media from message
interface MessageContent {
  text: string;
  mediaPath?: string;
  mediaType?: string;
  messageType: string;
}

function extractMessageContent(data: any): MessageContent {
  const msgtype = data.msgtype || 'text';
  
  switch (msgtype) {
    case 'text':
      return {
        text: data.text?.content?.trim() || '',
        messageType: 'text',
      };
      
    case 'richText':
      // Rich text contains multiple parts
      const parts = data.content?.richText || [];
      const textParts = parts
        .filter((p: any) => p.type === 'text')
        .map((p: any) => p.text)
        .join('');
      return {
        text: textParts || '[富文本消息]',
        messageType: 'richText',
      };
      
    case 'picture':
      return {
        text: '[图片]',
        mediaPath: data.content?.downloadCode,
        mediaType: 'image',
        messageType: 'picture',
      };
      
    case 'audio':
      // Voice message with recognition
      const recognition = data.content?.recognition;
      return {
        text: recognition || '[语音消息]',
        mediaPath: data.content?.downloadCode,
        mediaType: 'audio',
        messageType: 'audio',
      };
      
    case 'video':
      return {
        text: '[视频]',
        mediaPath: data.content?.downloadCode,
        mediaType: 'video',
        messageType: 'video',
      };
      
    case 'file':
      const fileName = data.content?.fileName || '文件';
      return {
        text: `[文件: ${fileName}]`,
        mediaPath: data.content?.downloadCode,
        mediaType: 'file',
        messageType: 'file',
      };
      
    default:
      return {
        text: data.text?.content?.trim() || `[${msgtype}消息]`,
        messageType: msgtype,
      };
  }
}

// Send text message
async function sendTextMessage(config: any, sessionWebhook: string, text: string, options: any = {}): Promise<any> {
  const token = await getAccessToken(config);
  
  const body: any = {
    msgtype: 'text',
    text: { content: text },
  };

  if (options.atUserId) {
    body.at = {
      atUserIds: [options.atUserId],
      isAtAll: false,
    };
  }

  const result = await axios({
    url: sessionWebhook,
    method: 'POST',
    data: body,
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
  });
  
  return { ok: true, data: result.data };
}

// Send markdown message
async function sendMarkdownMessage(config: any, sessionWebhook: string, title: string, markdown: string, options: any = {}): Promise<any> {
  const token = await getAccessToken(config);
  
  let finalText = markdown;
  // DingTalk Markdown MUST contain @userId in the text to trigger the "at" visual/notification
  if (options.atUserId) {
    finalText = `${finalText} @${options.atUserId}`;
  }

  const body: any = {
    msgtype: 'markdown',
    markdown: {
      title: title || 'Clawdbot 消息',
      text: finalText,
    },
  };

  if (options.atUserId) {
    body.at = {
      atUserIds: [options.atUserId],
      isAtAll: false,
    };
  }

  const result = await axios({
    url: sessionWebhook,
    method: 'POST',
    data: body,
    headers: {
      'x-acs-dingtalk-access-token': token,
      'Content-Type': 'application/json',
    },
  });
  
  return { ok: true, data: result.data };
}

// Smart send - choose format based on content
async function sendMessage(config: any, sessionWebhook: string, text: string, options: any = {}): Promise<any> {
  // Check if text has markdown features
  const hasMarkdownFeatures = /^[#*>-]|[*_`#\[\]]/.test(text) || text.includes('\n');
  const useMarkdown = options.useMarkdown !== false && (options.useMarkdown || hasMarkdownFeatures);
  
  if (useMarkdown) {
    // DingTalk requires a title (shown in notifications)
    const title = options.title || text.split('\n')[0].replace(/^[#*\s\->]+/, '').slice(0, 20) || 'Clawdbot 消息';
    return sendMarkdownMessage(config, sessionWebhook, title, text, options);
  }
  
  return sendTextMessage(config, sessionWebhook, text, options);
}

// Message handler - routes to Clawdbot AI
async function handleDingTalkMessage(params: {
  cfg: ClawdbotConfig;
  accountId: string;
  data: any;
  sessionWebhook: string;
  log?: any;
  dingtalkConfig: any;
}): Promise<void> {
  const { cfg, accountId, data, sessionWebhook, log, dingtalkConfig } = params;
  const rt = getRuntime();
  
  // Extract message content
  const content = extractMessageContent(data);
  
  if (!content.text) {
    log?.debug?.('[DingTalk] Skipping empty message');
    return;
  }
  
  const isDirect = data.conversationType === '1';
  const senderId = data.senderStaffId || data.senderId;
  const senderName = data.senderNick || 'Unknown';
  const groupId = data.conversationId;
  const groupName = data.conversationTitle || 'Group';
  
  // Download media if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  
  if (content.mediaPath && dingtalkConfig.robotCode) {
    const media = await downloadMedia(dingtalkConfig, content.mediaPath);
    if (media) {
      mediaPath = media.path;
      mediaType = media.mimeType;
      log?.debug?.(`[DingTalk] Downloaded media: ${mediaPath}`);
    }
  }

  // Resolve agent route
  const route = rt.channel.routing.resolveAgentRoute({
    cfg,
    channel: 'dingtalk',
    accountId,
    peer: {
      kind: isDirect ? 'dm' : 'group',
      id: isDirect ? senderId : groupId,
    },
  });

  const storePath = rt.channel.session.resolveStorePath(cfg.session?.store, {
    agentId: route.agentId,
  });

  // Format envelope options
  const envelopeOptions = rt.channel.reply.resolveEnvelopeFormatOptions(cfg);
  
  // Get previous timestamp for session continuity
  const previousTimestamp = rt.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });

  // Build from label
  const fromLabel = isDirect 
    ? `${senderName} (${senderId})`
    : `${groupName} - ${senderName}`;

  // Format the inbound message body
  const body = rt.channel.reply.formatInboundEnvelope({
    channel: 'DingTalk',
    from: fromLabel,
    timestamp: data.createAt,
    body: content.text,
    chatType: isDirect ? 'direct' : 'group',
    sender: { name: senderName, id: senderId },
    previousTimestamp,
    envelope: envelopeOptions,
  });

  const to = isDirect ? `dingtalk:${senderId}` : `dingtalk:group:${groupId}`;

  // Build inbound context
  const ctx = rt.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: content.text,
    CommandBody: content.text,
    From: to,
    To: to,
    SessionKey: route.sessionKey,
    AccountId: accountId,
    ChatType: isDirect ? 'direct' : 'group',
    ConversationLabel: fromLabel,
    GroupSubject: isDirect ? undefined : groupName,
    SenderName: senderName,
    SenderId: senderId,
    Provider: 'dingtalk',
    Surface: 'dingtalk',
    MessageSid: data.msgId,
    Timestamp: data.createAt,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    CommandAuthorized: true,
    OriginatingChannel: 'dingtalk',
    OriginatingTo: to,
  });

  // Record inbound session
  await rt.channel.session.recordInboundSession({
    storePath,
    sessionKey: ctx.SessionKey || route.sessionKey,
    ctx,
    updateLastRoute: isDirect ? {
      sessionKey: route.mainSessionKey,
      channel: 'dingtalk',
      to: senderId,
      accountId,
    } : undefined,
    onRecordError: (err: Error) => {
      log?.debug?.(`[DingTalk] Failed updating session meta: ${String(err)}`);
    },
  });

  log?.info?.(`[DingTalk] Inbound: from=${senderName} type=${content.messageType} text="${content.text.slice(0, 50)}..."`);

  // Create reply dispatcher
  const { dispatcher, replyOptions, markDispatchIdle } = rt.channel.reply.createReplyDispatcherWithTyping({
    responsePrefix: '',
    deliver: async (payload: any) => {
      try {
        // LOGGING: Let's see what Clawdbot is actually sending us
        console.log('[DingTalk] Dispatcher delivered payload:', JSON.stringify(payload));

        // Correctly extract text from the Clawdbot ReplyPayload object
        // Sometimes it's .markdown, sometimes it's .text
        const textToSend = payload.markdown || payload.text;
        
        if (!textToSend) {
          console.log('[DingTalk] Empty payload text, skipping');
          return { ok: true };
        }

        // Force markdown if the text contains markdown characters
        const isMarkdown = Boolean(payload.markdown) || /^[#*>-]|[*_`#\[\]]/.test(textToSend);

        console.log(`[DingTalk] Sending message. isMarkdown=${isMarkdown}`);

        await sendMessage(dingtalkConfig, sessionWebhook, textToSend, {
          atUserId: !isDirect ? senderId : null,
          useMarkdown: isMarkdown
        });
        return { ok: true };
      } catch (err: any) {
        log?.error?.(`[DingTalk] Reply failed: ${err.message}`);
        return { ok: false, error: err.message };
      }
    },
  });

  try {
    // Dispatch to AI agent
    await rt.channel.reply.dispatchReplyFromConfig({
      ctx,
      cfg,
      dispatcher,
      replyOptions,
    });
  } finally {
    markDispatchIdle();
    
    // Cleanup temp media file
    if (mediaPath && fs.existsSync(mediaPath)) {
      try {
        fs.unlinkSync(mediaPath);
      } catch {}
    }
  }
}

// Channel plugin metadata
const meta = {
  id: 'dingtalk',
  label: 'DingTalk',
  selectionLabel: 'DingTalk (钉钉)',
  docsPath: '/channels/dingtalk',
  blurb: '钉钉企业内部机器人，使用 Stream 模式，无需公网 IP。',
  aliases: ['dd', 'ding'],
};

// Channel plugin definition
const dingtalkPlugin = {
  id: 'dingtalk',
  meta,
  
  capabilities: {
    chatTypes: ['direct', 'group'],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  
  reload: { configPrefixes: ['channels.dingtalk'] },
  
  config: {
    listAccountIds: (cfg: ClawdbotConfig) => {
      const config = getConfig(cfg);
      if (config.accounts) {
        return Object.keys(config.accounts);
      }
      return isConfigured(cfg) ? ['default'] : [];
    },
    
    resolveAccount: (cfg: ClawdbotConfig, accountId?: string) => {
      const config = getConfig(cfg);
      const id = accountId || 'default';
      
      if (config.accounts?.[id]) {
        return {
          accountId: id,
          config: config.accounts[id],
          enabled: config.accounts[id].enabled !== false,
        };
      }
      
      return {
        accountId: 'default',
        config,
        enabled: config.enabled !== false,
      };
    },
    
    defaultAccountId: () => 'default',
    
    isConfigured: (account: any) => Boolean(
      account.config?.clientId && 
      account.config?.clientSecret
    ),
    
    describeAccount: (account: any) => ({
      accountId: account.accountId,
      name: account.config?.name || 'DingTalk',
      enabled: account.enabled,
      configured: Boolean(account.config?.clientId),
    }),
  },
  
  security: {
    resolveDmPolicy: ({ account }: any) => ({
      policy: account.config?.dmPolicy || 'open',
      allowFrom: account.config?.allowFrom || [],
      policyPath: 'channels.dingtalk.dmPolicy',
      allowFromPath: 'channels.dingtalk.allowFrom',
      approveHint: '使用 /allow dingtalk:<userId> 批准用户',
      normalizeEntry: (raw: string) => raw.replace(/^(dingtalk|dd|ding):/i, ''),
    }),
  },
  
  groups: {
    resolveRequireMention: ({ cfg }: any) => {
      const config = getConfig(cfg);
      return config.groupPolicy !== 'open';
    },
  },
  
  messaging: {
    normalizeTarget: ({ target }: any) => {
      if (!target) return null;
      const cleaned = target.replace(/^(dingtalk|dd|ding):/i, '');
      return { targetId: cleaned };
    },
    
    targetResolver: {
      looksLikeId: (id: string) => /^[\w-]+$/.test(id),
      hint: '<conversationId>',
    },
  },
  
  outbound: {
    deliveryMode: 'direct',
    
    sendText: async () => {
      // DingTalk requires sessionWebhook from inbound message
      return { ok: false, error: 'DingTalk requires sessionWebhook context' };
    },
  },
  
  gateway: {
    startAccount: async (ctx: any) => {
      const { account, cfg, abortSignal } = ctx;
      const config = account.config;
      
      if (!config.clientId || !config.clientSecret) {
        throw new Error('DingTalk clientId and clientSecret are required');
      }
      
      ctx.log?.info(`[${account.accountId}] Starting DingTalk Stream client...`);
      
      const client = new DWClient({
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        debug: config.debug || false,
      });
      
      // Register message callback
      client.registerCallbackListener(TOPIC_ROBOT, async (res: any) => {
        try {
          const messageId = res.headers?.messageId;
          const data = JSON.parse(res.data);
          
          if (config.debug) {
            ctx.log?.debug?.('[DingTalk] Received:', JSON.stringify(data, null, 2));
          }
          
          // Handle message through Clawdbot pipeline
          await handleDingTalkMessage({
            cfg,
            accountId: account.accountId,
            data,
            sessionWebhook: data.sessionWebhook,
            log: ctx.log,
            dingtalkConfig: config,
          });
          
          // Acknowledge message
          if (messageId) {
            client.socketCallBackResponse(messageId, { success: true });
          }
          
        } catch (error: any) {
          ctx.log?.error?.(`[DingTalk] Error processing message: ${error.message}`);
          if (config.debug) {
            ctx.log?.error?.(error.stack);
          }
          const messageId = res.headers?.messageId;
          if (messageId) {
            client.socketCallBackResponse(messageId, { success: false });
          }
        }
      });
      
      // Connect
      await client.connect();
      ctx.log?.info(`[${account.accountId}] DingTalk Stream client connected`);
      
      // Record activity
      const rt = getRuntime();
      rt.channel.activity.record('dingtalk', account.accountId, 'start');
      
      // Handle abort signal
      let stopped = false;
      if (abortSignal) {
        abortSignal.addEventListener('abort', () => {
          if (stopped) return;
          stopped = true;
          ctx.log?.info(`[${account.accountId}] Stopping DingTalk Stream client...`);
          rt.channel.activity.record('dingtalk', account.accountId, 'stop');
        });
      }
      
      return {
        stop: () => {
          if (stopped) return;
          stopped = true;
          ctx.log?.info(`[${account.accountId}] DingTalk provider stopped`);
          rt.channel.activity.record('dingtalk', account.accountId, 'stop');
        },
      };
    },
  },
  
  status: {
    defaultRuntime: {
      accountId: 'default',
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    
    probe: async ({ cfg }: any) => {
      if (!isConfigured(cfg)) {
        return { ok: false, error: 'Not configured' };
      }
      
      try {
        const config = getConfig(cfg);
        await getAccessToken(config);
        return { 
          ok: true, 
          details: { clientId: config.clientId },
        };
      } catch (error: any) {
        return { ok: false, error: error.message };
      }
    },
    
    buildChannelSummary: ({ snapshot }: any) => ({
      configured: snapshot?.configured ?? false,
      running: snapshot?.running ?? false,
      lastStartAt: snapshot?.lastStartAt ?? null,
      lastStopAt: snapshot?.lastStopAt ?? null,
      lastError: snapshot?.lastError ?? null,
    }),
  },
};

// Plugin registration
const plugin = {
  id: 'dingtalk',
  name: 'DingTalk Channel',
  description: 'DingTalk (钉钉) messaging channel via Stream mode',
  configSchema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      enabled: { type: 'boolean', default: true },
    },
  },
  register(api: ClawdbotPluginApi) {
    // Store runtime reference
    runtime = api.runtime;
    
    // Register channel
    api.registerChannel({ plugin: dingtalkPlugin });
    
    // Register RPC methods
    api.registerGatewayMethod('dingtalk.status', async ({ respond, cfg }: any) => {
      const result = await dingtalkPlugin.status.probe({ cfg });
      respond(true, result);
    });
    
    api.registerGatewayMethod('dingtalk.probe', async ({ respond, cfg }: any) => {
      const result = await dingtalkPlugin.status.probe({ cfg });
      respond(result.ok, result);
    });
    
    api.logger?.info('[DingTalk] Plugin registered');
  },
};

export default plugin;
export { dingtalkPlugin, sendMessage, sendTextMessage, sendMarkdownMessage };
