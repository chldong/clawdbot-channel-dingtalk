#!/usr/bin/env node
/**
 * 钉钉机器人测试脚本
 * 运行: node test.js
 * 
 * 在钉钉里 @机器人 或私聊机器人，这里会显示收到的消息并自动回复
 */

const { DingTalkChannel } = require('./index.js');

console.log('🤖 钉钉机器人测试');
console.log('================');
console.log('正在连接...\n');

const channel = new DingTalkChannel({
  debug: false, // 设为 true 可以看到更多日志
  onMessage: async (message) => {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log(`📨 收到消息 [${new Date().toLocaleTimeString()}]`);
    console.log(`   发送者: ${message.sender.name} (${message.sender.id})`);
    console.log(`   会话: ${message.conversation.type === 'private' ? '私聊' : '群聊: ' + message.conversation.title}`);
    console.log(`   类型: ${message.type}`);
    console.log(`   内容: ${message.text}`);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
    // 简单的 Echo 回复
    const reply = `🤖 收到你的消息:\n\n"${message.text}"\n\n——来自 Clawdbot 钉钉测试`;
    console.log(`📤 回复: ${reply.substring(0, 50)}...\n`);
    
    return reply;
  },
});

channel.start()
  .then(() => {
    console.log('✅ 已连接到钉钉服务器');
    console.log('📱 现在可以在钉钉里给机器人发消息了');
    console.log('   - 私聊机器人');
    console.log('   - 或在群里 @机器人');
    console.log('\n按 Ctrl+C 退出\n');
  })
  .catch(err => {
    console.error('❌ 连接失败:', err.message);
    process.exit(1);
  });

process.on('SIGINT', async () => {
  console.log('\n👋 正在关闭...');
  await channel.stop();
  process.exit(0);
});
