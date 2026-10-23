const PROGRESS_STORAGE_KEY = 'LIBRE_PLAY_PROGRESS_MAP';

Page({
  data: {
    videoName: '',
    episodeName: '',
    playUrl: '',
    sourceName: '',
    episodes: [],
    currentIndex: 0,
    initialTime: 0
  },

  onLoad() {
    this.videoContext = wx.createVideoContext('myVideo', this);
    this.retryCount = 0;
    this.lastSavedTime = 0;
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

    this.setData({
      videoName: videoName,
      episodeName: playData.episodeName,
      playUrl: playData.playUrl,
      sourceName: playData.sourceName,
      episodes: episodes,
      currentIndex: initialIndex,
      initialTime: initialTime,
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

    // 1. 针对 HLS bufferStalledError 进行自动恢复尝试（微调时间轴跳过停滞分片）
    if (detail.details === 'bufferStalledError' && this.retryCount < 2) {
      this.retryCount++;
      console.warn(`[Player] 触发缓冲区停滞，正在执行第 ${this.retryCount} 次自动跳跃挽救...`);
      if (this.videoContext) {
        this.videoContext.play();
      }
      return;
    }

    // 2. 针对 HTML 网页或格式解析错误给出清晰指引
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
  },

  onTimeUpdate(e) {
    const { currentTime, duration } = e.detail || {};
    // 每 3 秒节流保存一次播放进度，减少 storage I/O
    if (currentTime && (!this.lastSavedTime || Math.abs(currentTime - this.lastSavedTime) >= 3)) {
      this.lastSavedTime = currentTime;
      this.saveProgress(currentTime, duration);
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
