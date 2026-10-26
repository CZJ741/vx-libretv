import { callCloudWithRetry } from '../../utils/cloud-api';

const PROGRESS_STORAGE_KEY = 'LIBRE_PLAY_PROGRESS_MAP';

Page({
  data: {
    videoName: '',
    episodeName: '',
    playUrl: '',
    sourceName: '',
    sourceKey: '',
    episodes: [],
    currentIndex: 0,
    initialTime: 0,
    currentTime: 0,
    duration: 0,
    // 卡顿缓冲与挽救状态
    isBuffering: false,
    showStallAction: false,
    availableSources: [],
    currentSourceKey: '',
    switchingSource: false
  },

  onLoad() {
    this.videoContext = wx.createVideoContext('myVideo', this);
    this.retryCount = 0;
    this.lastSavedTime = 0;
    this.stallTimer = null;
    const app = getApp();
    const playData = app.globalData.currentPlayData;

    if (!playData) {
      wx.showToast({ title: '播放信息丢失', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1500);
      return;
    }

    const videoName = playData.videoName;
    const initialIndex = playData.episodeIndex || 0;
    const episodes = playData.episodes || [];
    const currentEp = episodes[initialIndex];
    const initialTime = this.getSavedProgress(videoName, currentEp ? currentEp.name : playData.episodeName);
    const isLongText = episodes.some(item => (item.name || '').length > 6);
    const availableSources = playData.sources || [];
    const currentSourceKey = playData.sourceKey || (availableSources[playData.currentSourceIndex || 0] || {}).sourceKey || '';

    this.setData({
      videoName: videoName,
      episodeName: playData.episodeName,
      playUrl: playData.playUrl,
      sourceName: playData.sourceName,
      sourceKey: currentSourceKey,
      currentSourceKey: currentSourceKey,
      availableSources: availableSources,
      episodes: episodes,
      currentIndex: initialIndex,
      initialTime: initialTime,
      currentTime: initialTime,
      isLongEpisodeText: isLongText
    });

    if (initialTime > 5) {
      const min = Math.floor(initialTime / 60);
      const sec = Math.floor(initialTime % 60);
      wx.showToast({
        title: `已为你恢复至 ${min > 0 ? min + '分' : ''}${sec}秒 播放`,
        icon: 'none',
        duration: 2000
      });
    }

    wx.setNavigationBarTitle({
      title: playData.videoName
    });
  },

  onUnload() {
    if (this.stallTimer) {
      clearTimeout(this.stallTimer);
      this.stallTimer = null;
    }
  },

  /**
   * 读取对应影视与剧集的历史播放秒数
   */
  getSavedProgress(videoName, epName) {
    if (!videoName) return 0;
    try {
      const map = wx.getStorageSync(PROGRESS_STORAGE_KEY) || {};
      const key = `${videoName}_${epName || '第1集'}`;
      const record = map[key];
      // 距离片尾不足 10 秒则不回跳，从头播放
      if (record && record.currentTime && (!record.duration || record.duration - record.currentTime > 10)) {
        return Math.floor(record.currentTime);
      }
    } catch (e) {
      console.warn('读取播放进度失败', e);
    }
    return 0;
  },

  /**
   * 保存当前播放进度到本地存储
   */
  saveProgress(currentTime, duration) {
    const { videoName, episodeName } = this.data;
    if (!videoName || !currentTime) return;

    try {
      const map = wx.getStorageSync(PROGRESS_STORAGE_KEY) || {};
      const key = `${videoName}_${episodeName || '第1集'}`;
      map[key] = {
        currentTime: currentTime,
        duration: duration || 0,
        updateTime: Date.now()
      };

      // 仅保留最近 100 条播放记录，防止缓存膨胀
      const keys = Object.keys(map);
      if (keys.length > 100) {
        keys.sort((a, b) => (map[a].updateTime || 0) - (map[b].updateTime || 0));
        while (keys.length > 100) {
          delete map[keys.shift()];
        }
      }

      wx.setStorageSync(PROGRESS_STORAGE_KEY, map);
    } catch (e) {
      console.warn('保存播放进度失败', e);
    }
  },

  onSelectEpisode(e) {
    const index = e.currentTarget.dataset.index;
    if (index === this.data.currentIndex) return;

    const targetEp = this.data.episodes[index];
    const initialTime = this.getSavedProgress(this.data.videoName, targetEp.name);

    this.setData({
      currentIndex: index,
      episodeName: targetEp.name,
      playUrl: targetEp.url,
      initialTime: initialTime
    });

    if (initialTime > 5) {
      const min = Math.floor(initialTime / 60);
      const sec = Math.floor(initialTime % 60);
      wx.showToast({
        title: `切换至 ${targetEp.name} (已记忆至 ${min > 0 ? min + '分' : ''}${sec}秒)`,
        icon: 'none'
      });
    } else {
      wx.showToast({
        title: `切换至 ${targetEp.name}`,
        icon: 'none'
      });
    }
  },

  onVideoError(e) {
    const detail = e.detail || {};
    console.error('播放器报错:', detail);

    this.setData({ isBuffering: false, showStallAction: true });

    // 1. 针对 HLS bufferStalledError 进行自动恢复尝试（微调时间轴跳过停滞分片）
    if (detail.details === 'bufferStalledError' && this.retryCount < 2) {
      this.retryCount++;
      console.warn(`[Player] 触发缓冲区停滞，正在执行第 ${this.retryCount} 次自动跳跃挽救...`);
      if (this.videoContext) {
        this.videoContext.play();
      }
      return;
    }

    // 2. 遇到错误且有备用源时，提示是否自动换源
    if (this.data.availableSources.length > 1) {
      wx.showModal({
        title: '播放遇到异常',
        content: '当前播放线路解析异常，是否为您无缝切换至其它线路继续播放？',
        confirmText: '立即换源',
        cancelText: '取消',
        success: (res) => {
          if (res.confirm) {
            this.onQuickSwitchSource();
          }
        }
      });
      return;
    }

    // 3. 针对 HTML 网页或格式解析错误给出清晰指引
    const isFormatError = (detail.errMsg || '').includes('Format error') || (this.data.playUrl || '').includes('/share/');
    const errorMsg = isFormatError ? '该集包含非标准视频流，建议切换其它源线路播放' : '该线路播放异常，建议返回切换其它来源';

    wx.showToast({
      title: errorMsg,
      icon: 'none',
      duration: 3500
    });
  },

  onVideoWaiting(e) {
    // 缓冲事件触发
    this.setData({ isBuffering: true });

    // 若缓冲超过 3.5 秒仍未恢复，显示“跳过卡顿/一键切源”辅助操作
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.stallTimer = setTimeout(() => {
      if (this.data.isBuffering) {
        this.setData({ showStallAction: true });
      }
    }, 3500);
  },

  onTimeUpdate(e) {
    const { currentTime, duration } = e.detail || {};
    // 只要时间在推进，说明缓冲结束，隐藏缓冲 HUD
    if (this.data.isBuffering || this.data.showStallAction) {
      if (this.stallTimer) {
        clearTimeout(this.stallTimer);
        this.stallTimer = null;
      }
      this.setData({
        isBuffering: false,
        showStallAction: false
      });
    }

    this.setData({
      currentTime: currentTime || 0,
      duration: duration || this.data.duration
    });

    // 每 3 秒节流保存一次播放进度，减少 storage I/O
    if (currentTime && (!this.lastSavedTime || Math.abs(currentTime - this.lastSavedTime) >= 3)) {
      this.lastSavedTime = currentTime;
      this.saveProgress(currentTime, duration);
    }
  },

  /**
   * 方案2：脱困操作——快进 5 秒跳过卡顿分片
   */
  onSkipStall() {
    const { currentTime, duration } = this.data;
    const targetTime = Math.min((currentTime || 0) + 5, (duration || 99999) - 2);
    if (this.videoContext) {
      this.videoContext.seek(targetTime);
      this.videoContext.play();
      wx.showToast({
        title: '已跳过 5 秒卡顿分片',
        icon: 'none'
      });
      this.setData({ isBuffering: false, showStallAction: false });
    }
  },

  /**
   * 方案4：一键复制播放链接，支持外部浏览器/专业播放器播放或投屏
   */
  onCopyPlayUrl() {
    const { playUrl, videoName, episodeName } = this.data;
    if (!playUrl) {
      wx.showToast({ title: '暂无播放链接', icon: 'none' });
      return;
    }

    wx.setClipboardData({
      data: playUrl,
      success: () => {
        wx.showModal({
          title: '播放链接已复制',
          content: `已复制【${videoName} - ${episodeName}】的 M3U8 直链，你可以粘贴到手机浏览器、PotPlayer、VLC 或投屏工具中直接播放。`,
          showCancel: false,
          confirmText: '我知道了'
        });
      }
    });
  },

  /**
   * 快捷换源（顺序切换到下一个可用源）
   */
  onQuickSwitchSource() {
    const { availableSources, currentSourceKey } = this.data;
    if (!availableSources || availableSources.length <= 1) return;

    const currIdx = availableSources.findIndex(s => s.sourceKey === currentSourceKey);
    const nextIdx = (currIdx + 1) % availableSources.length;
    this.switchSourceByIndex(nextIdx);
  },

  onSelectSource(e) {
    const index = e.currentTarget.dataset.index;
    this.switchSourceByIndex(index);
  },

  onOpenSourceSelector() {
    const { availableSources, currentSourceKey } = this.data;
    if (!availableSources || availableSources.length <= 1) {
      wx.showToast({ title: '当前仅有 1 条播放源', icon: 'none' });
      return;
    }

    const itemList = availableSources.map(s => `${s.sourceName}${s.sourceKey === currentSourceKey ? ' (当前)' : ''}`);
    wx.showActionSheet({
      itemList: itemList,
      success: (res) => {
        this.switchSourceByIndex(res.tapIndex);
      }
    });
  },

  /**
   * 核心实现：平滑/无缝带播放进度切源
   */
  async switchSourceByIndex(index) {
    const { availableSources, currentSourceKey, currentIndex, currentTime, videoName, episodeName } = this.data;
    const targetSource = availableSources[index];
    if (!targetSource || targetSource.sourceKey === currentSourceKey) return;

    if (this.data.switchingSource) return;
    this.setData({ switchingSource: true });

    wx.showLoading({ title: `正在连接${targetSource.sourceName}...`, mask: true });

    try {
      // 请求目标源详情以获取其对应的剧集列表
      const res = await callCloudWithRetry('cmsProxy', {
        action: 'detail',
        source: {
          key: targetSource.sourceKey,
          name: targetSource.sourceName
        },
        id: targetSource.vodId
      }, 1);

      if (res.result && res.result.ok && res.result.data) {
        const detailData = res.result.data;
        const newEpisodes = detailData.episodes || [];

        if (newEpisodes.length === 0) {
          wx.showToast({ title: `${targetSource.sourceName} 暂无可播剧集`, icon: 'none' });
          return;
        }

        // 尝试匹配相同剧集（按集数名称或索引）
        let targetEp = newEpisodes.find(ep => ep.name === episodeName);
        let targetEpIndex = targetEp ? newEpisodes.indexOf(targetEp) : -1;

        if (!targetEp) {
          // 兜底按当前集数下标
          targetEpIndex = Math.min(currentIndex, newEpisodes.length - 1);
          targetEp = newEpisodes[targetEpIndex];
        }

        // 保留当前已播放时间点继续无缝续播
        const resumeTime = currentTime > 3 ? Math.floor(currentTime) : 0;

        this.setData({
          sourceName: targetSource.sourceName,
          sourceKey: targetSource.sourceKey,
          currentSourceKey: targetSource.sourceKey,
          episodes: newEpisodes,
          currentIndex: targetEpIndex,
          episodeName: targetEp.name,
          playUrl: targetEp.url,
          initialTime: resumeTime,
          isBuffering: false,
          showStallAction: false
        });

        // 重新同步到 app 全局状态
        const app = getApp();
        if (app.globalData.currentPlayData) {
          app.globalData.currentPlayData.sourceName = targetSource.sourceName;
          app.globalData.currentPlayData.sourceKey = targetSource.sourceKey;
          app.globalData.currentPlayData.episodes = newEpisodes;
          app.globalData.currentPlayData.playUrl = targetEp.url;
          app.globalData.currentPlayData.currentSourceIndex = index;
        }

        wx.showToast({
          title: `已换至【${targetSource.sourceName}】${resumeTime > 0 ? '续播中' : ''}`,
          icon: 'none',
          duration: 2500
        });
      } else {
        wx.showToast({ title: '换源失败，请尝试其他线路', icon: 'none' });
      }
    } catch (err) {
      console.error('切换播放源异常:', err);
      wx.showToast({ title: '换源网络异常', icon: 'none' });
    } finally {
      wx.hideLoading();
      this.setData({ switchingSource: false });
    }
  },

  onVideoEnded() {
    // 播完清零进度
    this.saveProgress(0, 0);

    // 自动连播下一集
    const { currentIndex, episodes } = this.data;
    if (currentIndex + 1 < episodes.length) {
      const nextIndex = currentIndex + 1;
      const nextEp = episodes[nextIndex];
      const initialTime = this.getSavedProgress(this.data.videoName, nextEp.name);

      this.setData({
        currentIndex: nextIndex,
        episodeName: nextEp.name,
        playUrl: nextEp.url,
        initialTime: initialTime
      });
      wx.showToast({
        title: `自动播放下一集：${nextEp.name}`,
        icon: 'none'
      });
    }
  }
});
