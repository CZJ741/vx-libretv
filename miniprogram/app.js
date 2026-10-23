// app.js
import { warmupCloud } from './utils/cloud-api';

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
    } else {
      wx.cloud.init({
        // 留空使用默认环境，或填入你在微信公众平台开通的云开发环境 ID
        // env: 'your-env-id',
        traceUser: true,
      });

      // 启动时在后台静默预热云函数实例，消除首次搜索冷启动延迟
      warmupCloud();
    }
  },
  globalData: {
    currentVideo: null
  }
});
