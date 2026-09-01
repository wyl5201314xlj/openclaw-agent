// lib/tools/timer_tool.js
class TimerTool {
  constructor() {
    this.timers = new Map();
  }

  parseTimeOffset(text) {
    let seconds = 0;
    // 匹配 "X分钟后" / "X秒后" / "X小时后"
    const minMatch = text.match(/(\d+)\s*(?:分钟|分|mins?|m)/);
    const secMatch = text.match(/(\d+)\s*(?:秒钟|秒|secs?|s)/);
    const hourMatch = text.match(/(\d+)\s*(?:小时|个钟|hours?|h)/);

    if (minMatch) seconds += parseInt(minMatch[1]) * 60;
    if (secMatch) seconds += parseInt(secMatch[1]);
    if (hourMatch) seconds += parseInt(hourMatch[1]) * 3600;

    return seconds > 0 ? seconds : 180; // 默认 3 分钟
  }

  scheduleReminder(durationSeconds, message, targetOpenid, isGroup, callback) {
    const timerId = 'timer-' + Date.now();
    console.log(`[TimerTool] 已设定定时提醒 (ID: ${timerId})，将在 ${durationSeconds} 秒后触发: "${message}"`);

    const timeoutHandle = setTimeout(async () => {
      console.log(`[TimerTool] ⏰ 定时器触发: ${message} (To: ${targetOpenid})`);
      this.timers.delete(timerId);
      try {
        await callback(targetOpenid, isGroup, `⏰ 【定时管家主动提醒】\n报告主人！您设定的提醒时间到了：\n👉 ${message}`);
      } catch (err) {
        console.error('[TimerTool] 定时提醒推送异常:', err);
      }
    }, durationSeconds * 1000);

    this.timers.set(timerId, {
      id: timerId,
      message,
      targetOpenid,
      triggerAt: new Date(Date.now() + durationSeconds * 1000).toISOString(),
      handle: timeoutHandle
    });

    return { timerId, durationSeconds, message };
  }
}

module.exports = new TimerTool();
