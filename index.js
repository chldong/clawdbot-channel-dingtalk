/**
 * DingTalk Channel for Clawdbot
 * 
 * 使用钉钉 Stream 模式接收机器人消息
 * 无需公网 IP，通过 WebSocket 长连接接收消息
 */

const { DWClient, TOPIC_ROBOT } = require('dingtalk-stream');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 配置文件路径
const CONFIG_PATH = path.join(process.env.HOME, '.config/dingtalk/credentials.json');

class DingTalkChannel {
  constructor(options = {}) {
    this.config = this.loadConfig();
    this.client = null;
    this.messageHandler = options.onMessage || (() => {});
    this.debug = options.debug || false;
  }

  loadConfig() {
    if (!fs.existsSync(CONFIG_PATH)) {
      throw new Error(`配置文件不存在: ${CONFIG_PATH}`);
    }
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
  }

  log(...args) {
    if (this.debug) {
      console.log('[DingTalk]', ...args);
    }
  }

  async start() {
    this.log('正在启动钉钉 Stream 客户端...');
    
    this.client = new DWClient({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
      debug: this.debug,
    });

    // 注册机器人消息回调
    this.client.registerCallbackListener(TOPIC_ROBOT, async (res) => {
      try {
        await this.handleRobotMessage(res);
      } catch (error) {
        console.error('[DingTalk] 处理消息出错:', error);
      }
    });

    // 连接到钉钉服务器
    await this.client.connect();
    this.log('钉钉 Stream 客户端已连接');
  }

  async handleRobotMessage(res) {
    const messageId = res.headers?.messageId;
    const data = JSON.parse(res.data);
    
    this.log('收到消息:', JSON.stringify(data, null, 2));

    // 解析消息
    const message = {
      id: data.msgId || messageId,
      type: data.msgtype || 'text',
      text: this.extractText(data),
      sender: {
        id: data.senderStaffId || data.senderId,
        name: data.senderNick,
        isAdmin: data.isAdmin || false,
      },
      conversation: {
        id: data.conversationId,
        type: data.conversationType === '1' ? 'private' : 'group',
        title: data.conversationTitle,
      },
      platform: data.senderPlatform,
      timestamp: data.createAt,
      raw: data,
      // 用于回复的 webhook
      sessionWebhook: data.sessionWebhook,
      sessionWebhookExpiredTime: data.sessionWebhookExpiredTime,
    };

    // 调用消息处理器
    const reply = await this.messageHandler(message);

    // 如果有回复，发送消息
    if (reply) {
      await this.sendReply(message, reply);
    }

    // 确认消息已处理
    if (messageId) {
      this.client.socketCallBackResponse(messageId, { success: true });
    }
  }

  extractText(data) {
    if (data.text?.content) {
      return data.text.content.trim();
    }
    if (data.content?.content) {
      return data.content.content;
    }
    if (data.msgtype === 'audio' && data.content?.recognition) {
      // 语音消息，使用钉钉的语音识别结果
      return data.content.recognition;
    }
    return '';
  }

  async sendReply(originalMessage, reply) {
    const accessToken = await this.client.getAccessToken();
    
    // 构建消息体
    let body;
    if (typeof reply === 'string') {
      body = {
        msgtype: 'text',
        text: { content: reply },
      };
    } else if (reply.markdown) {
      body = {
        msgtype: 'markdown',
        markdown: {
          title: reply.title || '回复',
          text: reply.markdown,
        },
      };
    } else {
      body = reply;
    }

    // 如果是群聊，可以 @ 发送者
    if (originalMessage.conversation.type === 'group' && originalMessage.sender.id) {
      body.at = {
        atUserIds: [originalMessage.sender.id],
        isAtAll: false,
      };
    }

    try {
      // 使用 sessionWebhook 回复（最简单的方式）
      if (originalMessage.sessionWebhook) {
        const result = await axios({
          url: originalMessage.sessionWebhook,
          method: 'POST',
          data: body,
          headers: {
            'x-acs-dingtalk-access-token': accessToken,
            'Content-Type': 'application/json',
          },
        });
        this.log('消息发送成功:', result.data);
        return result.data;
      }
    } catch (error) {
      console.error('[DingTalk] 发送消息失败:', error.response?.data || error.message);
      throw error;
    }
  }

  async sendMessage(conversationId, message, options = {}) {
    const accessToken = await this.client.getAccessToken();
    
    let body;
    if (typeof message === 'string') {
      body = {
        msgtype: 'text',
        text: { content: message },
      };
    } else {
      body = message;
    }

    // 根据会话类型选择 API
    const url = options.isGroup
      ? 'https://api.dingtalk.com/v1.0/robot/groupMessages/send'
      : 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend';

    const payload = options.isGroup
      ? {
          robotCode: this.config.robotCode,
          openConversationId: conversationId,
          ...body,
        }
      : {
          robotCode: this.config.robotCode,
          userIds: [conversationId],
          ...body,
        };

    try {
      const result = await axios({
        url,
        method: 'POST',
        data: payload,
        headers: {
          'x-acs-dingtalk-access-token': accessToken,
          'Content-Type': 'application/json',
        },
      });
      this.log('消息发送成功:', result.data);
      return result.data;
    } catch (error) {
      console.error('[DingTalk] 发送消息失败:', error.response?.data || error.message);
      throw error;
    }
  }

  async stop() {
    if (this.client) {
      // SDK 没有明确的断开方法，这里留空
      this.log('钉钉客户端已停止');
    }
  }
}

// 独立运行测试
if (require.main === module) {
  const channel = new DingTalkChannel({
    debug: true,
    onMessage: async (message) => {
      console.log('收到消息:', message.text);
      console.log('发送者:', message.sender.name);
      console.log('会话类型:', message.conversation.type);
      
      // Echo 回复
      return `收到你的消息: ${message.text}`;
    },
  });

  channel.start().catch(console.error);
  
  process.on('SIGINT', async () => {
    console.log('\n正在关闭...');
    await channel.stop();
    process.exit(0);
  });
}

module.exports = { DingTalkChannel };
