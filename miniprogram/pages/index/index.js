import { callCloudWithRetry } from '../../utils/cloud-api';

// 大类分类映射字典
const CATEGORY_MAP = {
  movie: ['电影', '片', '动作', '喜剧', '爱情', '科幻', '恐怖', '剧情', '战争', '惊悚', '犯罪', '纪录'],
  tv: ['剧', '连续剧', '国产', '欧美', '韩剧', '日剧', '泰剧', '港剧', '台剧'],
  anime: ['动漫', '动画', '番剧', '二次元', '新番'],
  variety: ['综艺', '真人秀', '脱口秀', '晚会']
};

// 8 大精选榜单配置（每行 4 个，完美填满双行网格）
const HOT_LISTS = [
  { id: 'douban_movie_weekly', label: '电影周榜' },
  { id: 'douban_tv_weekly', label: '影视剧周榜' },
  { id: 'douban_movie_top', label: '高分电影' },
  { id: 'douban_tv_top_cn', label: '内地高分剧' },
  { id: 'douban_tv_top_global', label: '海外高分剧' },
  { id: 'douban_show_chinese', label: '国内综艺' },
  { id: 'douban_show_global', label: '海外综艺' },
  { id: 'hot_short_drama', label: '热播短剧' }
];

const SEARCH_HISTORY_KEY = 'LIBRE_SEARCH_HISTORY';
const PAGE_SIZE = 18;

Page({
  data: {
    keyword: '',
    loading: false,
    hasSearched: false,
    rawList: [], // 原始搜索列表
    filteredList: [], // 经过分类/排序后的最终渲染列表

    // 历史搜索记录
    searchHistory: [],

    // 榜单相关状态
    hotLists: HOT_LISTS,
    activeHotTab: 'douban_movie_weekly',

    // 滚动分页加载状态
    hotRankItems: [],
    hotRankLoading: false,
    isPagingLoading: false, // 触底加载中
    hasMore: true,
    pageStart: 0,

    // 搜索结果分类与排序状态
    categoryTabs: [
      { key: 'all', name: '全部' },
      { key: 'movie', name: '电影' },
      { key: 'tv', name: '电视剧' },
      { key: 'anime', name: '动漫' },
      { key: 'variety', name: '综艺' }
    ],
    activeCategory: 'all',

    sortOptions: [
      { key: 'default', name: '综合' },
      { key: 'year', name: '最新' },
      { key: 'sources', name: '最多源' }
    ],
    activeSort: 'default'
  },

  onLoad() {
    this.currentRankRequestId = 0; // 自增请求序号，用于拦截网络竞态冲突
    this.loadSearchHistory();
    this.fetchHotRank(this.data.activeHotTab, true);
  },

  /**
   * 读取本地历史搜索记录
   */
  loadSearchHistory() {
    try {
      const history = wx.getStorageSync(SEARCH_HISTORY_KEY) || [];
      this.setData({ searchHistory: history });
    } catch (e) {
      console.warn('读取搜索历史失败', e);
    }
  },

  /**
   * 保存关键词到历史记录（去重并保留最近 10 条）
   */
  saveSearchKeyword(keyword) {
    if (!keyword || !keyword.trim()) return;
    const word = keyword.trim();
    let history = this.data.searchHistory.filter(item => item !== word);
    history.unshift(word);
    if (history.length > 10) {
      history = history.slice(0, 10);
    }
    this.setData({ searchHistory: history });
    try {
      wx.setStorageSync(SEARCH_HISTORY_KEY, history);
    } catch (e) {
      console.warn('保存搜索历史失败', e);
    }
  },

  /**
   * 删除单个历史记录
   */
  onDeleteSingleHistory(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;

    const newHistory = this.data.searchHistory.filter(item => item !== word);
    this.setData({ searchHistory: newHistory });

    try {
      wx.setStorageSync(SEARCH_HISTORY_KEY, newHistory);
    } catch (err) {
      console.warn('删除历史记录项失败', err);
    }
  },

  /**
   * 清空历史搜索记录
   */
  onClearHistory() {
    wx.showModal({
      title: '提示',
      content: '确定清空所有搜索历史吗？',
      success: (res) => {
        if (res.confirm) {
          this.setData({ searchHistory: [] });
          wx.removeStorageSync(SEARCH_HISTORY_KEY);
        }
      }
    });
  },

  /**
   * 页面触底滚动监听（分页加载）
   */
  onReachBottom() {
    if (this.data.hasSearched) return;

    if (!this.data.hasMore || this.data.hotRankLoading || this.data.isPagingLoading) {
      return;
    }

    this.fetchHotRank(this.data.activeHotTab, false);
  },

  /**
   * 拉取指定影视榜单（带增量 setData 优化与竞态丢弃）
   * @param {string} listId 榜单 ID
   * @param {boolean} isRefresh 是否刷新重置列表
   */
  async fetchHotRank(listId, isRefresh = true) {
    const requestId = ++this.currentRankRequestId;

    if (isRefresh) {
      this.setData({
        hotRankLoading: true,
        pageStart: 0,
        hasMore: true,
        hotRankItems: []
      });
    } else {
      this.setData({
        isPagingLoading: true
      });
    }

    const currentPageStart = isRefresh ? 0 : this.data.pageStart;

    try {
      const res = await callCloudWithRetry('cmsProxy', {
        action: 'getHotList',
        listId: listId,
        pageStart: currentPageStart,
        pageSize: PAGE_SIZE
      }, 1);

      // 竞态拦截：如果用户已切换了其他 Tab，丢弃过期的网络回调
      if (requestId !== this.currentRankRequestId) {
        console.log('[RaceCondition] 丢弃已过期的榜单数据:', listId);
        return;
      }

      if (res && res.result && res.result.ok && Array.isArray(res.result.items)) {
        const newItems = res.result.items;
        const currentLen = this.data.hotRankItems.length;

        if (isRefresh) {
          this.setData({
            hotRankItems: newItems,
            pageStart: newItems.length,
            hasMore: res.result.hasMore !== undefined ? res.result.hasMore : newItems.length >= PAGE_SIZE
          });
        } else {
          // 增量路径更新（高性能 setData，零重复序列化，解决下拉掉帧）
          const updatePayload = {
            pageStart: currentPageStart + newItems.length,
            hasMore: res.result.hasMore !== undefined ? res.result.hasMore : newItems.length >= PAGE_SIZE
          };
          newItems.forEach((item, index) => {
            updatePayload[`hotRankItems[${currentLen + index}]`] = item;
          });
          this.setData(updatePayload);
        }
      } else {
        if (isRefresh) {
          this.setData({ hotRankItems: [], hasMore: false });
        }
      }
    } catch (err) {
      console.warn('获取影视榜单异常:', err);
      if (requestId === this.currentRankRequestId && isRefresh) {
        this.setData({ hotRankItems: [], hasMore: false });
      }
    } finally {
      if (requestId === this.currentRankRequestId) {
        this.setData({
          hotRankLoading: false,
          isPagingLoading: false
        });
      }
    }
  },

  /**
   * 切换影视榜单 Tab
   */
  onHotTabChange(e) {
    const listId = e.currentTarget.dataset.id;
    if (this.data.activeHotTab === listId) return;

    this.setData({
      activeHotTab: listId
    });

    this.fetchHotRank(listId, true);
  },

  /**
   * 点击历史记录标签：填入搜索框并执行搜索
   */
  onPickKeyword(e) {
    const word = e.currentTarget.dataset.word;
    if (!word) return;
    this.setData({
      keyword: word
    }, () => {
      this.onSearch();
    });
  },

  /**
   * 直接点击榜单影视卡片：不跳搜索列表，直接跳转到详情页播放
   */
  onRankCardTap(e) {
    const item = e.currentTarget.dataset.item;
    if (!item) return;

    const app = getApp();
    app.globalData.currentVideo = {
      name: item.title,
      pic: item.cover,
      sources: [] // 由详情页异步精准拉取播放线路
    };

    wx.navigateTo({
      url: `/pages/detail/detail?name=${encodeURIComponent(item.title)}`
    });
  },

  onInput(e) {
    this.setData({
      keyword: e.detail.value
    });
  },

  onClear() {
    this.setData({
      keyword: '',
      hasSearched: false,
      activeCategory: 'all',
      activeSort: 'default'
    });
    if (this.data.hotRankItems.length === 0) {
      this.fetchHotRank(this.data.activeHotTab, true);
    }
  },

  async onSearch() {
    const wd = this.data.keyword.trim();
    if (!wd) {
      wx.showToast({ title: '请输入搜索关键词', icon: 'none' });
      return;
    }

    // 保存搜索历史
    this.saveSearchKeyword(wd);

    this.setData({
      loading: true,
      hasSearched: true,
      activeCategory: 'all',
      activeSort: 'default',
      rawList: [], // 立即清空上一次的搜索数据，避免闪烁上一部影视
      filteredList: []
    });

    try {
      const res = await callCloudWithRetry('cmsProxy', {
        action: 'search',
        wd: wd
      }, 1);

      if (res.result && res.result.ok) {
        const rawList = res.result.list || [];
        this.setData({
          rawList: rawList
        }, () => {
          this.applyFilterAndSort();
        });
      } else {
        wx.showToast({
          title: (res.result && res.result.error) || '搜索失败',
          icon: 'none'
        });
      }
    } catch (err) {
      console.error('搜索请求异常:', err);
      wx.showToast({
        title: '搜索异常，请稍后重试',
        icon: 'none'
      });
    } finally {
      this.setData({ loading: false });
    }
  },

  onCategoryChange(e) {
    const key = e.currentTarget.dataset.key;
    if (this.data.activeCategory === key) return;
    this.setData({ activeCategory: key }, () => {
      this.applyFilterAndSort();
    });
  },

  onSortChange(e) {
    const key = e.currentTarget.dataset.key;
    if (this.data.activeSort === key) return;
    this.setData({ activeSort: key }, () => {
      this.applyFilterAndSort();
    });
  },

  applyFilterAndSort() {
    const { rawList, activeCategory, activeSort } = this.data;
    let list = [...rawList];

    // 1. 类型过滤
    if (activeCategory !== 'all') {
      const matchKeywords = CATEGORY_MAP[activeCategory] || [];
      list = list.filter(item => {
        const typeName = (item.typeName || '').trim();
        return matchKeywords.some(keyword => typeName.includes(keyword));
      });
    }

    // 2. 排序处理
    if (activeSort === 'year') {
      list.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        return yearB - yearA;
      });
    } else if (activeSort === 'sources') {
      list.sort((a, b) => {
        const countA = (a.sources && a.sources.length) || 0;
        const countB = (b.sources && b.sources.length) || 0;
        return countB - countA;
      });
    }

    this.setData({
      filteredList: list
    });
  },

  onVideoTap(e) {
    const item = e.currentTarget.dataset.item;
    const app = getApp();
    app.globalData.currentVideo = item;
    wx.navigateTo({
      url: `/pages/detail/detail?name=${encodeURIComponent(item.name)}`
    });
  }
});
