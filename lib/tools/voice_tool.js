// lib/tools/voice_tool.js
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const fs = require('fs');
const path = require('path');
const os = require('os');

class VoiceTool {
  async synthesize(text, voice = 'zh-CN-XiaoxiaoNeural') {
    const cleanText = text.replace(/<[^>]+>/g, '').slice(0, 100).trim();
    if (!cleanText) throw new Error('文本为空');

    const tts = new MsEdgeTTS();
    let tempDir = null;
    try {
      await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice_'));
      const res = await tts.toFile(tempDir, cleanText, { pitch: '+0Hz', rate: '+0%' });
      const buffer = fs.readFileSync(res.audioFilePath);
      return buffer;
    } finally {
      try { tts.close(); } catch (_) {}
      if (tempDir) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
      }
    }
  }
}

module.exports = new VoiceTool();
