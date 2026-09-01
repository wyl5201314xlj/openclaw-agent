// lib/time_parse.js
// 中文时间表达解析（阶段 1-5）。
//
// 旧实现只认「阿拉伯数字 + 分/秒/小时」，实测把「下午3点」「明天早上8点」「一分钟后」
// 「半小时后」全部静默落到 180 秒默认值，且不报错不告知用户。
// 这里改为：相对时长与绝对时刻两类分别解析，解析不出来就明确返回 ok:false，
// 由调用方回问或回显，绝不猜一个默认值。
//
// 时区：容器跑在 UTC，而主人在中国（UTC+8，全年无夏令时），
// 「下午3点」必须理解为北京时间 15:00，因此绝对时刻一律按固定 +8 偏移换算。

const TZ_OFFSET_MINUTES = Number(process.env.TZ_OFFSET_MINUTES || 480);
const MS_PER_MINUTE = 60 * 1000;

const CN_DIGITS = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

/** 把「十」「二十三」「一百」这类中文数字转成阿拉伯数字（够用范围 0-999） */
function cnNumberToInt(cn) {
  const s = String(cn);
  if (/^\d+$/.test(s)) return Number(s);
  let total = 0;
  let section = 0;
  let lastDigit = 0;
  let sawDigit = false;
  for (const ch of s) {
    if (CN_DIGITS[ch] !== undefined) {
      lastDigit = CN_DIGITS[ch];
      sawDigit = true;
    } else if (ch === '十') {
      section += (sawDigit ? lastDigit : 1) * 10;
      lastDigit = 0;
      sawDigit = false;
    } else if (ch === '百') {
      section += (sawDigit ? lastDigit : 1) * 100;
      lastDigit = 0;
      sawDigit = false;
    } else {
      return NaN;
    }
  }
  total += section + lastDigit;
  return total;
}

/** 把文本里的中文数字统一替换成阿拉伯数字，便于后续正则统一处理 */
function normalizeNumbers(text) {
  let out = String(text || '');
  // 先处理「一个半小时」「两个半钟头」这类带"半"的量
  out = out.replace(/([零一二两三四五六七八九十百]+)个?半\s*(小时|钟头|个钟)/g, (_m, num, unit) => {
    const n = cnNumberToInt(num);
    return Number.isNaN(n) ? _m : `${n + 0.5}${unit}`;
  });
  out = out.replace(/(\d+)个?半\s*(小时|钟头|个钟)/g, (_m, num, unit) => `${Number(num) + 0.5}${unit}`);
  // 「半小时」「半个小时」→ 0.5 小时；「半分钟」→ 0.5 分钟
  out = out.replace(/半个?\s*(小时|钟头|个钟)/g, '0.5$1');
  out = out.replace(/半\s*(分钟|分)/g, '0.5分钟');
  // 「一刻钟」= 15 分钟，「三刻钟」= 45 分钟
  out = out.replace(/([零一二两三四五六七八九十]+|\d+)\s*刻钟?/g, (_m, num) => {
    const n = cnNumberToInt(num);
    return Number.isNaN(n) ? _m : `${n * 15}分钟`;
  });
  // 独立的中文数字量词
  out = out.replace(
    /([零一二两三四五六七八九十百]+)\s*(小时|钟头|个钟|分钟|分|秒钟|秒|天|周|星期|个小时)/g,
    (_m, num, unit) => {
      const n = cnNumberToInt(num);
      return Number.isNaN(n) ? _m : `${n}${unit}`;
    }
  );
  // 绝对时刻里的中文数字：「下午三点」「八点半」
  out = out.replace(/([零一二两三四五六七八九十]+)\s*(点|时)(半|钟)?/g, (_m, num, unit, tail) => {
    const n = cnNumberToInt(num);
    if (Number.isNaN(n)) return _m;
    return `${n}${unit}${tail === '半' ? '半' : ''}`;
  });
  out = out.replace(/([零一二两三四五六七八九十]+)\s*分(?!钟)/g, (_m, num) => {
    const n = cnNumberToInt(num);
    return Number.isNaN(n) ? _m : `${n}分`;
  });
  return out;
}

// ---------------- 相对时长 ----------------

const UNIT_SECONDS = {
  秒: 1, 秒钟: 1,
  分: 60, 分钟: 60,
  小时: 3600, 个小时: 3600, 钟头: 3600, 个钟: 3600,
  天: 86400,
  周: 604800, 星期: 604800,
};

const RE_DURATION = /(\d+(?:\.\d+)?)\s*(秒钟|秒|分钟|分|个小时|小时|钟头|个钟|天|星期|周)/g;

/** 解析「30分钟后」「1小时20分钟后」「0.5小时后」；返回秒数，无匹配返回 null */
function parseDuration(normalizedText) {
  let seconds = 0;
  let matchedAny = false;
  let lastEnd = -1;
  for (const m of normalizedText.matchAll(RE_DURATION)) {
    const value = Number(m[1]);
    const unit = UNIT_SECONDS[m[2]];
    if (!Number.isFinite(value) || !unit) continue;
    seconds += value * unit;
    matchedAny = true;
    lastEnd = m.index + m[0].length;
  }
  if (!matchedAny) return null;
  // 必须出现「后 / 之后 / 以后 / 过后 / later」这类未来指向词，
  // 否则「提醒我看一下这道题的得分」里的"分"会被误判成时长（实测旧版就是这个坑）
  const tail = normalizedText.slice(Math.max(0, lastEnd), lastEnd + 6);
  const hasFutureMarker = /^(?:钟)?\s*(?:之?后|以后|过后|後)/.test(tail);
  if (!hasFutureMarker) return null;
  return Math.round(seconds);
}

// ---------------- 绝对时刻 ----------------

const DAY_OFFSET = {
  今天: 0, 今日: 0, 今晚: 0, 今早: 0,
  明天: 1, 明日: 1, 明早: 1, 明晚: 1,
  后天: 2, 後天: 2,
  大后天: 3,
};

const MERIDIEM = {
  凌晨: 'am', 早上: 'am', 早晨: 'am', 上午: 'am', 清晨: 'am',
  中午: 'noon', 正午: 'noon',
  下午: 'pm', 傍晚: 'pm', 晚上: 'pm', 晚间: 'pm', 夜里: 'pm', 夜晚: 'pm', 今晚: 'pm', 明晚: 'pm',
};

const RE_CLOCK =
  /(今天|今日|今晚|今早|明天|明日|明早|明晚|后天|後天|大后天)?\s*(凌晨|早晨|早上|清晨|上午|中午|正午|下午|傍晚|晚上|晚间|夜里|夜晚)?\s*(\d{1,2})\s*(?:[点時时:：])\s*(\d{1,2})?\s*(分|半)?/;

/**
 * 解析绝对时刻，返回 {triggerAt, matchedText}；无匹配返回 null。
 * 没写日期且今天该时刻已过，则顺延到明天。
 */
function parseClock(normalizedText, nowMs) {
  const m = normalizedText.match(RE_CLOCK);
  if (!m) return null;

  const [matchedText, dayWord, meridiemWord, hourStr, minuteStr, minuteSuffix] = m;
  let hour = Number(hourStr);
  if (!Number.isInteger(hour) || hour < 0 || hour > 24) return null;

  let minute = 0;
  if (minuteSuffix === '半' && !minuteStr) minute = 30;
  else if (minuteStr !== undefined) minute = Number(minuteStr);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;

  // 「今晚8点」这类词既指日期也指时段
  const meridiem = MERIDIEM[meridiemWord] || MERIDIEM[dayWord] || null;
  if (meridiem === 'pm' && hour < 12) hour += 12;
  if (meridiem === 'am' && hour === 12) hour = 0;
  if (meridiem === 'noon' && hour < 12) hour += 12;
  if (hour === 24) hour = 0;

  // 换算到北京时间的"墙上时钟"再回到 UTC
  const nowShifted = new Date(nowMs + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
  const y = nowShifted.getUTCFullYear();
  const mo = nowShifted.getUTCMonth();
  const d = nowShifted.getUTCDate();

  let dayDelta = DAY_OFFSET[dayWord] ?? null;
  let targetUtc = Date.UTC(y, mo, d + (dayDelta ?? 0), hour, minute, 0, 0)
    - TZ_OFFSET_MINUTES * MS_PER_MINUTE;

  if (dayDelta === null && targetUtc <= nowMs) {
    // 没指定日期且时刻已过 → 顺延到明天
    targetUtc += 24 * 3600 * 1000;
    dayDelta = 1;
  }
  if (targetUtc <= nowMs) return null; // 明确写了"今天"但时刻已过

  return { triggerAt: targetUtc, matchedText, dayDelta: dayDelta ?? 0, hour, minute };
}

// ---------------- 对外统一入口 ----------------

const MIN_SECONDS = 5;
const MAX_SECONDS = 30 * 86400; // 上限 30 天，超过就当解析异常

/** 把 UTC 毫秒格式化成北京时间的人类可读串，供回显给用户确认 */
function formatBeijing(ms, nowMs = Date.now()) {
  const shift = (t) => new Date(t + TZ_OFFSET_MINUTES * MS_PER_MINUTE);
  const target = shift(ms);
  const now = shift(nowMs);
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = `${pad(target.getUTCHours())}:${pad(target.getUTCMinutes())}`;
  const dayDiff = Math.round(
    (Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), target.getUTCDate()) -
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) /
      86400000
  );
  const prefix = { 0: '今天', 1: '明天', 2: '后天' }[dayDiff];
  if (prefix) return `${prefix} ${hhmm}`;
  return `${target.getUTCMonth() + 1}月${target.getUTCDate()}日 ${hhmm}`;
}

/** 从原文里剥掉时间表达与「提醒我」之类的引导词，得到真正要提醒的事 */
function extractRemindText(originalText, matchedText) {
  let text = String(originalText || '');
  if (matchedText) {
    text = text.replace(matchedText, ' ');
  }
  text = text
    // 只剥时间表达紧跟的"后/之后/以后"，不用贪婪的 .*后（旧版正因贪婪把正文吃掉了）
    .replace(/^\s*(?:钟)?\s*(?:之后|以后|过后|后|後)/, ' ')
    .replace(/(?:请|帮我|麻烦你?|记得|到时候?)/g, ' ')
    .replace(/提醒\s*(?:我|一下|下)?/g, ' ')
    .replace(/叫\s*我/g, ' ')
    .replace(/^[\s,，。、:：!！?？~-]+|[\s,，。、~-]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text;
}

/**
 * 解析一句提醒指令里的时间与事项。
 * 解析不出时间时返回 ok:false，**绝不猜默认值**——这是旧版最大的坑。
 * @param {string} text 用户原话
 * @param {number} [nowMs] 便于单元测试注入固定"现在"
 * @returns {{ok:boolean, kind?:'relative'|'absolute', triggerAt?:number, seconds?:number,
 *            remindText?:string, humanTime?:string, matchedText?:string, reason?:string}}
 */
function parseSchedule(text, nowMs = Date.now()) {
  const original = String(text || '');
  if (!original.trim()) return { ok: false, reason: '内容为空' };
  const normalized = normalizeNumbers(original);

  // 相对时长优先：「30分钟后」比「3点」更明确，且用户说相对时长时往往不含时刻
  const seconds = parseDuration(normalized);
  if (seconds !== null) {
    if (seconds < MIN_SECONDS) {
      return { ok: false, reason: `时长 ${seconds} 秒过短，最少需要 ${MIN_SECONDS} 秒` };
    }
    if (seconds > MAX_SECONDS) {
      return { ok: false, reason: '时长超过 30 天上限，请确认是否说错' };
    }
    // 用"连续多个时长 + 未来指向词"整体匹配，才能把「1小时20分钟后」当成一个整体剥掉
    const durationMatch = normalized.match(
      /(?:\d+(?:\.\d+)?\s*(?:秒钟|秒|分钟|分|个小时|小时|钟头|个钟|天|星期|周)\s*)+(?:钟)?\s*(?:之后|以后|过后|后|後)?/
    );
    const triggerAt = nowMs + seconds * 1000;
    return {
      ok: true,
      kind: 'relative',
      triggerAt,
      seconds,
      matchedText: durationMatch ? durationMatch[0] : undefined,
      remindText: extractRemindText(normalized, durationMatch ? durationMatch[0] : ''),
      humanTime: formatBeijing(triggerAt, nowMs),
    };
  }

  const clock = parseClock(normalized, nowMs);
  if (clock) {
    const secs = Math.round((clock.triggerAt - nowMs) / 1000);
    if (secs > MAX_SECONDS) {
      return { ok: false, reason: '目标时刻超过 30 天上限，请确认是否说错' };
    }
    return {
      ok: true,
      kind: 'absolute',
      triggerAt: clock.triggerAt,
      seconds: secs,
      matchedText: clock.matchedText,
      remindText: extractRemindText(normalized, clock.matchedText),
      humanTime: formatBeijing(clock.triggerAt, nowMs),
    };
  }

  return {
    ok: false,
    reason: '没能识别出具体时间。可以说「30分钟后」「2小时后」「下午3点」「明天早上8点」这类说法',
  };
}

module.exports = {
  TZ_OFFSET_MINUTES,
  cnNumberToInt,
  normalizeNumbers,
  parseDuration,
  parseClock,
  parseSchedule,
  extractRemindText,
  formatBeijing,
  UNIT_SECONDS,
};
