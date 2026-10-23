import { callCloudWithRetry } from '../../utils/cloud-api';

Page({
  data: {
    loading: true,
    detail: null,
    sources: [],
    currentSourceIndex: 0
  },

  onLoad(options) {
    const app = getApp();
    const currentVideo = app.globalData.currentVideo;

    if (!currentVideo) {
      wx.showToast({ title: '参数丢失', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    this.setData({
      detail: null, // 进入页面立即清空上一次遗留的详情数据
      sources: currentVideo.sources || [],
      currentSourceIndex: 0
    });

    if (currentVideo.sources && currentVideo.sources.length > 0) {
      this.fetchDetail(currentVideo.sources[0]);
    } else if (currentVideo.name) {
      // 兼容直接从榜单点击进来的卡片（自动发起后台静默聚合并直接展示第一源详情）
      this.fetchDetailByName(currentVideo.name, currentVideo.pic);
    }
  },

  async fetchDetailByName(name, pic) {
    this.setData({ loading: true });
    try {
      const res = await callCloudWithRetry('cmsProxy', {
        action: 'search',
        wd: name
      }, 1);

      const list = (res.result && res.result.list) || [];
      // 优先精准匹配片名完全相同的项目
      const matched = list.find(item => item.name === name) || list[0];

      if (matched && matched.sources && matched.sources.length > 0) {
        this.setData({
          sources: matched.sources,
          currentSourceIndex: 0
        });
        this.fetchDetail(matched.sources[0]);
      } else {
        wx.showToast({ title: '暂无可播资源源', icon: 'none' });
        this.setData({ loading: false });
      }
    } catch (e) {
      console.error('根据片名查详情失败:', e);
      this.setData({ loading: false });
      wx.showToast({ title: '资源获取异常', icon: 'none' });
    }
  },

  async fetchDetail(sourceItem) {
    this.setData({ loading: true });

    try {
      const res = await callCloudWithRetry('cmsProxy', {
        action: 'detail',
        source: {
          key: sourceItem.sourceKey,
          name: sourceItem.sourceName
        },
        id: sourceItem.vodId
      }, 1);

      if (res.result && res.result.ok) {
        const detailData = res.result.data || {};
        const epList = detailData.episodes || [];
        // 判断剧集名称平均字符长度，如果多为长文本（如综艺带期数或副标题），启用双列宽排版
        const isLongText = epList.some(item => (item.name || '').length > 6);

        this.setData({
          detail: detailData,
          isLongEpisodeText: isLongText
        });
      } else {
        wx.showToast({
          title: (res.result && res.result.error) || '获取详情失败',
          icon: 'none'
        });
      }
    } catch (err) {
      console.error('获取详情异常:', err);
      wx.showToast({ title: '加载失败', icon: 'none' });
    } finally {
      this.setData({ loading: false });
    }
  },

  onSwitchSource(e) {
    const index = e.currentTarget.dataset.index;
    if (index === this.data.currentSourceIndex) return;

    this.setData({ currentSourceIndex: index });
    const targetSource = this.data.sources[index];
    this.fetchDetail(targetSource);
  },

  onPlayEpisode(e) {
    const { ep, index } = e.currentTarget.dataset;
    const { detail, sources, currentSourceIndex } = this.data;
    const currentSource = sources[currentSourceIndex];

    // 将播放上下文带到播放器页面
    const playData = {
      videoName: detail.name,
      episodeName: ep.name,
      playUrl: ep.url,
      episodeIndex: index,
      episodes: detail.episodes,
      sourceName: currentSource.sourceName
    };

    const app = getApp();
    app.globalData.currentPlayData = playData;

    wx.navigateTo({
      url: '/pages/player/player'
    });
  }
});
