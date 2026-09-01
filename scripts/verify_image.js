// scripts/verify_image.js
// 阶段 1-4 验收：生图真实耗时与富媒体数据是否就绪。
// 注意：单次生图实测 44~47 秒，本脚本会真的调用一次接口。
// 凭据由 scripts/run_with_creds.py 注入环境变量，本文件不含任何凭据。
const imageTool = require('../lib/tools/image_tool');

(async () => {
  console.log(`账号与模型: ${JSON.stringify(imageTool.snapshot())}`);
  console.log('\n=== 生成一张图（旧版 45s 超时会在临成功时被掐断）===');
  const t0 = Date.now();
  const res = await imageTool.generateImage('一只戴墨镜的橘猫，扁平插画风格');
  const ms = Date.now() - t0;

  if (!res.ok) {
    console.log(`   ✗ 失败（${ms}ms）: ${res.reason}`);
    process.exit(1);
  }

  console.log(`   ✓ 成功 | 通道=${res.via} | 耗时=${ms}ms（配置上限 ${require('../lib/config').config.timeouts.imageMs}ms）`);
  console.log(`   返回 url=${res.url ? res.url.slice(0, 90) : '(无)'}`);
  console.log(`   返回 b64=${res.b64 ? `${res.b64.length} 字符` : '(无)'}`);

  if (res.url) {
    console.log('\n=== 下载二进制（QQ 富媒体 base64 兜底路径要用）===');
    try {
      const t1 = Date.now();
      const { buffer, mime } = await imageTool.fetchBytes(res.url);
      console.log(`   ✓ 下载 ${buffer.length} 字节 mime=${mime} 用时 ${Date.now() - t1}ms`);
      const isPng = buffer.slice(0, 4).toString('hex') === '89504e47';
      const isJpg = buffer.slice(0, 2).toString('hex') === 'ffd8';
      console.log(`   文件头校验: ${isPng ? 'PNG' : isJpg ? 'JPEG' : '未知'}`);
      process.exit(isPng || isJpg ? 0 : 1);
    } catch (err) {
      console.log(`   ✗ 下载失败: ${err.message}`);
      process.exit(1);
    }
  }
  process.exit(0);
})();
