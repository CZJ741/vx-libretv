/**
 * 封装云函数调用：
 * 1. 自动重试机制（默认失败/超时自动重试 1 次，专克冷启动）
 * 2. 避免首次进入时 wx.cloud 未初始化完成
 */

let isWarmingUp = false;

/**
 * 静默预热云函数实例（冷启动消抖）
 */
export function warmupCloud() {
  if (isWarmingUp) return;
  isWarmingUp = true;
  wx.cloud.callFunction({
    name: 'cmsProxy',
    data: { action: 'ping' }
  }).then(() => {
    console.log('[CloudAPI] 云函数静默预热就绪');
  }).catch((err) => {
    console.warn('[CloudAPI] 预热请求已发出:', err.message);
  }).finally(() => {
    isWarmingUp = false;
  });
}

/**
 * 带重试的云函数安全调用方法
 * @param {string} name 云函数名称
 * @param {object} data 传入参数
 * @param {number} retries 重试次数，默认 1 次
 */
export async function callCloudWithRetry(name, data, retries = 1) {
  let attempt = 0;
  while (attempt <= retries) {
    try {
      const res = await wx.cloud.callFunction({
        name,
        data,
      });
      return res;
    } catch (err) {
      attempt++;
      console.warn(`[CloudAPI] 调用云函数 ${name} 失败 (第 ${attempt} 次):`, err);
      if (attempt > retries) {
        throw err;
      }
      // 出现错误（大概率为冷启动超时或网络抖动），稍候 300ms 立即执行重试
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
}
