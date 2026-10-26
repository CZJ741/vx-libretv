const cloud = require('wx-server-sdk');
const axios = require('axios');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV
});

const DEFAULT_SOURCES = [
  { key: 'ffzy', name: '非凡资源', url: 'https://cj.ffzyapi.com/api.php/provide/vod' },
  { key: 'ryzy', name: '如意资源', url: 'https://cj.rycjapi.com/api.php/provide/vod' },
  { key: 'bfzy', name: '暴风资源', url: 'https://bfzyapi.com/api.php/provide/vod' },
  { key: 'lzzy', name: '量子资源', url: 'https://cj.lziapi.com/api.php/provide/vod' }
];

const UA_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

// 内存缓存管理（避免频繁请求上游 API）
const memoryCache = new Map();
function getCache(key) {
  const item = memoryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    memoryCache.delete(key);
    return null;
  }
  return item.value;
}
function setCache(key, value, ttl = 30 * 60 * 1000) {
  memoryCache.set(key, { value, expiresAt: Date.now() + ttl });
}

// 影视热榜与 60s 豆瓣周榜分类映射
const HOT_LIST_CATEGORY = {
  douban_movie_weekly: 'movie',
  douban_tv_weekly: 'tv_chinese',
  douban_show_chinese: 'show_chinese',
  douban_show_global: 'show_global'
};

const SIXTY_BASES = ['https://60s.crystelf.top', 'https://60s.viki.moe'];

/**
 * 格式化图片地址：
 * 1. 豆瓣防盗链：doubanio 针对小程序环境拦截，通过稳定公共镜像加速解析
 * 2. 百度海报：若为 http 协议强制转换为 https，避免小程序禁止非合规明文加载
 */
function cleanCoverUrl(url) {
  if (!url || typeof url !== 'string') return '';
  let cleaned = url.trim();

  // 协议升级为 https
  if (cleaned.startsWith('http://')) {
    cleaned = cleaned.replace(/^http:\/\//i, 'https://');
  }

  // 豆瓣防盗链替换为微信小程序可直连的无防盗链 CDN 镜像
  if (cleaned.includes('doubanio.com')) {
    cleaned = cleaned.replace(/img\d+\.doubanio\.com/g, 'img.doubanio.cmliussss.net');
  }

  return cleaned;
}

/**
 * 请求 60s 聚合热榜 API（多实例兜底）
 */
async function fetchSixtyJson(endpoint) {
  for (const base of SIXTY_BASES) {
    try {
      const res = await axios.get(`${base}${endpoint}`, {
        headers: UA_HEADERS,
        timeout: 5000
      });
      if (res.data) return res.data;
    } catch (err) {
      console.warn(`60s 节点 ${base} 访问失败:`, err.message);
    }
  }
  throw new Error('热榜服务暂时不可用');
}

/**
 * 豆瓣分类分页获取：
 * 支持按评分降序(sort=rank)或综合推荐(sort=recommend)，过滤评分有效的高口碑剧作
 */
async function fetchDoubanSubjectList(type, tag, pageStart = 0, pageSize = 18, sortBy = 'rank') {
  const cacheKey = `douban_subj:${type}:${tag}:${sortBy}:${pageStart}:${pageSize}`;
  const cached = getCache(cacheKey);
  if (cached) return cached;

  const DOUBAN_API = `https://movie.douban.com/j/search_subjects?type=${type}&tag=${encodeURIComponent(tag)}&sort=${sortBy}&page_limit=${pageSize}&page_start=${pageStart}`;
  const PROXIES = [
    (url) => url, // 直接请求
    (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
  ];

  for (const proxyFn of PROXIES) {
    try {
      const targetUrl = proxyFn(DOUBAN_API);
      const res = await axios.get(targetUrl, {
        headers: {
          ...UA_HEADERS,
          Referer: 'https://movie.douban.com/'
        },
        timeout: 6000
      });
      const data = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
      if (data && Array.isArray(data.subjects)) {
        const items = data.subjects
          .filter((s) => s.title && s.cover)
          .map((s) => ({
            id: String(s.id),
            title: s.title,
            cover: cleanCoverUrl(s.cover),
            rating: s.rate && s.rate !== '0' ? s.rate : '',
            isTv: type === 'tv',
            desc: s.rate ? `豆瓣评分 ${s.rate}` : ''
          }));
        setCache(cacheKey, items, 30 * 60 * 1000);
        return items;
      }
    } catch (e) {
      console.warn(`获取豆瓣数据失败 [${type}/${tag}]:`, e.message);
    }
  }
  return [];
}

/**
 * 海外高分剧多地区聚合推送逻辑：
 * 依次交替或并行聚合 美剧(欧美) + 英剧 + 韩剧 + 日剧 中的顶级高分作品（按评分降序与高分过滤）
 */
async function fetchGlobalTopTvList(pageStart = 0, pageSize = 18) {
  const cacheKey = `global_top_tv_pool`;
  let pool = getCache(cacheKey);

  if (!pool || pool.length === 0) {
    const REGION_TAGS = ['美剧', '英剧', '韩剧', '日剧'];
    const fetchPromises = REGION_TAGS.map((tag) =>
      fetchDoubanSubjectList('tv', tag, 0, 30, 'rank')
    );

    const results = await Promise.all(fetchPromises);
    const [usList, ukList, krList, jpList] = results;

    const merged = [];
    const maxLen = Math.max(usList.length, ukList.length, krList.length, jpList.length);

    for (let i = 0; i < maxLen; i++) {
      if (usList[i]) merged.push(usList[i]);
      if (krList[i]) merged.push(krList[i]);
      if (ukList[i]) merged.push(ukList[i]);
      if (jpList[i]) merged.push(jpList[i]);
    }

    const seen = new Set();
    pool = merged.filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });

    if (pool.length > 0) {
      setCache(cacheKey, pool, 60 * 60 * 1000);
    }
  }

  return pool.slice(pageStart, pageStart + pageSize);
}

/**
 * 计算短剧热度分（综合多源重合度、集数规模、更新时效与关键词热度）
 */
function calculateDramaHeat(item, totalOccurrences = 1) {
  let score = 50000;

  // 1. 多采集源同时收录加权（代表各大资源站力推的爆款）
  score += totalOccurrences * 15000;

  // 2. 集数规模（完结且集数多代表完整长篇大作）
  const playUrl = item.vod_play_url || '';
  const epCount = playUrl.split('#').length;
  score += Math.min(25000, epCount * 250);

  // 3. 热门爆款题材词命中加权
  const HOT_KEYWORDS = ['战神', '重生', '逆袭', '豪门', '龙王', '隐龙', '天师', '闪婚', '千金', '神医', '首富', '钟馗', '山海'];
  for (const kw of HOT_KEYWORDS) {
    if ((item.vod_name || '').includes(kw)) {
      score += 6000;
      break;
    }
  }

  // 4. 时效性（今天更新的排在更前面）
  const timeStr = item.vod_time || '';
  if (timeStr) {
    const pubTime = new Date(timeStr.replace(/-/g, '/')).getTime();
    if (!isNaN(pubTime)) {
      const hoursAgo = Math.max(0, (Date.now() - pubTime) / (3600 * 1000));
      score += Math.max(0, Math.floor(10000 - hoursAgo * 300));
    }
  }

  return score;
}

function formatHeatLabel(score) {
  if (score >= 10000) {
    return `热度 ${(score / 10000).toFixed(1)}w`;
  }
  return `热度 ${score}`;
}

/**
 * 获取实时热播短剧列表：
 * 按【真实热度算法降序排序】+ 智能混排 AI 漫剧，支持真实分页
 */
async function fetchShortDramaList(pageStart = 0, pageSize = 18) {
  const cacheKey = `short_drama_heat_pool_v3`;
  let pool = getCache(cacheKey);

  if (!pool || pool.length === 0) {
    // 并发拉取量子短剧 (typeId=46)、非凡短剧 (typeId=36)、量子AI漫剧 (typeId=52)
    const tasks = [
      axios.get('https://cj.lziapi.com/api.php/provide/vod?ac=detail&t=46&pg=1', { headers: UA_HEADERS, timeout: 5000 }).catch(() => null),
      axios.get('https://cj.lziapi.com/api.php/provide/vod?ac=detail&t=46&pg=2', { headers: UA_HEADERS, timeout: 5000 }).catch(() => null),
      axios.get('https://cj.ffzyapi.com/api.php/provide/vod?ac=detail&t=36&pg=1', { headers: UA_HEADERS, timeout: 5000 }).catch(() => null),
      axios.get('https://cj.lziapi.com/api.php/provide/vod?ac=detail&t=52&pg=1', { headers: UA_HEADERS, timeout: 5000 }).catch(() => null)
    ];

    try {
      const [lz1, lz2, ff1, aiRes] = await Promise.all(tasks);

      const realRaw = [
        ...((lz1 && lz1.data && lz1.data.list) || []),
        ...((lz2 && lz2.data && lz2.data.list) || []),
        ...((ff1 && ff1.data && ff1.data.list) || [])
      ];
      const aiRaw = (aiRes && aiRes.data && aiRes.data.list) || [];

      // 统计片名在各源中出现的频次
      const nameFreq = new Map();
      for (const item of realRaw) {
        if (!item.vod_name) continue;
        const norm = item.vod_name.trim();
        nameFreq.set(norm, (nameFreq.get(norm) || 0) + 1);
      }

      // 清洗并计算热度分（真人短剧）
      const realSeen = new Set();
      const scoredReal = [];
      for (const item of realRaw) {
        if (!item.vod_name || !item.vod_pic || realSeen.has(item.vod_name)) continue;
        realSeen.add(item.vod_name);

        const freq = nameFreq.get(item.vod_name.trim()) || 1;
        const heat = calculateDramaHeat(item, freq);

        scoredReal.push({
          id: `short_${item.vod_id}`,
          title: item.vod_name,
          cover: cleanCoverUrl(item.vod_pic),
          rating: '',
          isTv: true,
          tag: '短剧',
          heat,
          desc: item.vod_remarks || formatHeatLabel(heat)
        });
      }

      // 清洗并计算热度分（AI 剧）
      const scoredAi = [];
      for (const item of aiRaw) {
        if (!item.vod_name || !item.vod_pic) continue;
        const heat = calculateDramaHeat(item, 1) + 2000; // AI新颖加成
        scoredAi.push({
          id: `ai_${item.vod_id}`,
          title: item.vod_name,
          cover: cleanCoverUrl(item.vod_pic),
          rating: '',
          isTv: true,
          tag: 'AI漫剧',
          heat,
          desc: item.vod_remarks || 'AI连载'
        });
      }

      // 各自按热度从高到低排序
      scoredReal.sort((a, b) => b.heat - a.heat);
      scoredAi.sort((a, b) => b.heat - a.heat);

      // 智能交织：真人短剧与 AI 漫剧交错排布，保持热度高者居前
      const merged = [];
      const totalLen = Math.max(scoredReal.length, scoredAi.length);
      for (let i = 0; i < totalLen; i++) {
        if (scoredReal[i * 2]) merged.push(scoredReal[i * 2]);
        if (scoredReal[i * 2 + 1]) merged.push(scoredReal[i * 2 + 1]);
        if (scoredAi[i]) merged.push(scoredAi[i]);
      }

      // 补齐遗留条目
      const remain = [...scoredReal, ...scoredAi];
      for (const item of remain) {
        if (!merged.some((m) => m.id === item.id)) {
          merged.push(item);
        }
      }

      pool = merged;
      if (pool.length > 0) {
        setCache(cacheKey, pool, 20 * 60 * 1000);
      }
    } catch (err) {
      console.warn('热度计算与短剧抓取失败:', err.message);
    }
  }

  return (pool || []).slice(pageStart, pageStart + pageSize);
}

/**
 * 获取综艺榜单（国内综艺 / 海外综艺）：
 * 1. 深度解析 60s 豆瓣周榜的扁平结构 (entry.title, entry.rating, entry.card_subtitle 等)
 * 2. 结合采集源大陆综艺(type 25)与日韩/欧美综艺(type 27/28)以及豆瓣官方推荐池，实现无限平滑滚动分页
 */
async function fetchVarietyList(listId, pageStart = 0, pageSize = 18) {
  const isGlobal = listId === 'douban_show_global';
  const cacheKey = `variety_pool_${listId}`;
  let pool = getCache(cacheKey);

  if (!pool || pool.length === 0) {
    const weeklyCat = isGlobal ? 'show_global' : 'show_chinese';
    const weeklyTask = fetchSixtyJson(`/v2/douban/weekly/${weeklyCat}`).catch(() => null);
    const doubanTask = fetchDoubanSubjectList('tv', '综艺', 0, 40, 'recommend').catch(() => []);

    // 采集源实时综艺兜底补充 (大陆综艺 25, 日韩综艺 27, 欧美综艺 28)
    const cmsTypeId = isGlobal ? 27 : 25;
    const cmsTask = axios
      .get(`https://cj.lziapi.com/api.php/provide/vod?ac=detail&t=${cmsTypeId}&pg=1`, {
        headers: UA_HEADERS,
        timeout: 5000
      })
      .catch(() => null);

    const [weeklyRes, doubanSubjects, cmsRes] = await Promise.all([weeklyTask, doubanTask, cmsTask]);

    const formattedWeekly = [];
    if (weeklyRes && Array.isArray(weeklyRes.data)) {
      for (const entry of weeklyRes.data) {
        const title = entry.title || (entry.subject && entry.subject.title) || '';
        const rawCover = entry.cover || entry.cover_proxy || (entry.subject && (entry.subject.cover_url || entry.subject.pic?.normal)) || '';
        const rating = entry.rating || (entry.subject && entry.subject.rating?.value) || '';
        const desc = entry.card_subtitle ? entry.card_subtitle.split('/')[0].trim() : (entry.weekly_topic || '');

        if (title && rawCover) {
          formattedWeekly.push({
            id: String(entry.id || (entry.subject && entry.subject.id) || ''),
            title,
            cover: cleanCoverUrl(rawCover),
            rating: rating ? String(rating) : '',
            isTv: true,
            desc: desc || (rating ? `豆瓣评分 ${rating}` : '本周热播')
          });
        }
      }
    }

    // 采集源综艺补充
    const cmsList = (cmsRes && cmsRes.data && cmsRes.data.list) || [];
    const formattedCms = cmsList
      .filter((item) => item.vod_name && item.vod_pic)
      .map((item) => ({
        id: `cms_${item.vod_id}`,
        title: item.vod_name,
        cover: cleanCoverUrl(item.vod_pic),
        rating: item.vod_score && item.vod_score !== '0.0' ? item.vod_score : '',
        isTv: true,
        desc: item.vod_remarks || '更新中'
      }));

    // 合并去重构建综合综艺池
    const seen = new Set();
    const combined = [];
    for (const item of [...formattedWeekly, ...doubanSubjects, ...formattedCms]) {
      if (!item.title || seen.has(item.title)) continue;
      seen.add(item.title);
      combined.push(item);
    }

    pool = combined;
    if (pool.length > 0) {
      setCache(cacheKey, pool, 30 * 60 * 1000);
    }
  }

  return (pool || []).slice(pageStart, pageStart + pageSize);
}

/**
 * 获取指定影视榜单（无地域筛选，支持滚动分页）
 */
async function fetchHotListData(listId, pageStart = 0, pageSize = 18) {
  // 1. 高分电影榜：按豆瓣评分硬核倒序推选（sort=rank）
  if (listId === 'douban_movie_top') {
    return await fetchDoubanSubjectList('movie', '豆瓣高分', pageStart, pageSize, 'rank');
  }

  // 2. 内地高分剧榜：严选国产剧评分排行最高代表作（大明王朝1566、毛骗、红楼梦、河西走廊等经典神剧）
  if (listId === 'douban_tv_top_cn') {
    return await fetchDoubanSubjectList('tv', '国产剧', pageStart, pageSize, 'rank');
  }

  // 3. 海外高分剧榜：真正的全球多源高分聚合（美剧、英剧、韩剧、日剧顶级高分跨品类推送）
  if (listId === 'douban_tv_top_global') {
    return await fetchGlobalTopTvList(pageStart, pageSize);
  }

  // 4. 热播短剧（按实时热度降序排列，混合真人爆款与 AI 漫剧）
  if (listId === 'hot_short_drama') {
    return await fetchShortDramaList(pageStart, pageSize);
  }

  // 5. 电影周榜（第 1 页走 60s 电影周榜，后续平滑过渡为热门电影分页）
  if (listId === 'douban_movie_weekly') {
    if (pageStart === 0) {
      try {
        const raw = await fetchSixtyJson('/v2/douban/weekly/movie');
        const list = (raw && raw.data) || [];
        const items = list.map((entry) => {
          const title = entry.title || (entry.subject && entry.subject.title) || '';
          const rawCover = entry.cover || entry.cover_proxy || (entry.subject && (entry.subject.cover_url || entry.subject.pic?.normal)) || '';
          const rating = entry.rating || (entry.subject && entry.subject.rating?.value) || '';
          return {
            id: String(entry.id || (entry.subject && entry.subject.id) || ''),
            title,
            cover: cleanCoverUrl(rawCover),
            rating: rating ? String(rating) : '',
            isTv: false,
            desc: entry.weekly_topic || (entry.card_subtitle ? entry.card_subtitle.split('/')[0].trim() : '')
          };
        }).filter((item) => item.title && item.cover);
        if (items.length > 0) return items;
      } catch (err) {
        console.warn('获取 60s 电影周榜失败，回退豆瓣热门...');
      }
    }
    return await fetchDoubanSubjectList('movie', '热门', pageStart, pageSize, 'recommend');
  }

  // 6. 影视剧周榜（实时热播国产+海外综合周榜）
  if (listId === 'douban_tv_weekly') {
    if (pageStart === 0) {
      try {
        const raw = await fetchSixtyJson('/v2/douban/weekly/tv_chinese');
        const list = (raw && raw.data) || [];
        const items = list.map((entry) => {
          const title = entry.title || (entry.subject && entry.subject.title) || '';
          const rawCover = entry.cover || entry.cover_proxy || (entry.subject && (entry.subject.cover_url || entry.subject.pic?.normal)) || '';
          const rating = entry.rating || (entry.subject && entry.subject.rating?.value) || '';
          return {
            id: String(entry.id || (entry.subject && entry.subject.id) || ''),
            title,
            cover: cleanCoverUrl(rawCover),
            rating: rating ? String(rating) : '',
            isTv: true,
            desc: entry.weekly_topic || (entry.card_subtitle ? entry.card_subtitle.split('/')[0].trim() : '')
          };
        }).filter((item) => item.title && item.cover);
        if (items.length > 0) return items;
      } catch (e) {}
    }
    return await fetchDoubanSubjectList('tv', '国产剧', pageStart, pageSize, 'recommend');
  }

  // 7. 国内综艺与海外综艺（专属滚动加载池与精准字段归一化）
  if (listId === 'douban_show_chinese' || listId === 'douban_show_global') {
    return await fetchVarietyList(listId, pageStart, pageSize);
  }

  return [];
}

/**
 * 智能解析播放集数列表：
 * 1. 优先匹配真正的视频直链组（m3u8 / ffm3u8 / lzm3u8 等）
 * 2. 深度过滤 /share/ 或未带流媒体后缀的网页解析器 HTML 地址，确保小程序 video 能稳定加载
 */
function parseEpisodes(playUrlStr, playFromStr = '') {
  if (!playUrlStr || typeof playUrlStr !== 'string') return [];

  const fromGroups = (playFromStr || '').split('$$$');
  const urlGroups = playUrlStr.split('$$$');

  // 1. 优先寻找标明为 m3u8 的真正视频流线路组
  let bestGroupIndex = urlGroups.findIndex((g, idx) => {
    const fromName = (fromGroups[idx] || '').toLowerCase();
    return fromName.includes('m3u8') || g.includes('.m3u8');
  });

  // 如果没有匹配到包含 m3u8 标识的组，尝试寻找不包含 /share/ 的组
  if (bestGroupIndex === -1) {
    bestGroupIndex = urlGroups.findIndex((g) => !g.includes('/share/'));
  }

  // 兜底取第一组
  if (bestGroupIndex === -1) bestGroupIndex = 0;

  const targetGroup = urlGroups[bestGroupIndex] || '';
  const list = targetGroup.split('#');
  const episodes = [];

  for (const item of list) {
    const parts = item.split('$');
    let name = '';
    let url = '';

    if (parts.length >= 2) {
      name = parts[0].trim();
      url = parts[1].trim();
    } else if (parts.length === 1 && parts[0].trim()) {
      name = `第 ${episodes.length + 1} 集`;
      url = parts[0].trim();
    }

    // 过滤掉明显的网页解析器地址
    if (url && !url.includes('/share/')) {
      episodes.push({ name, url });
    }
  }

  // 如果严格过滤后为空（有些老片仅提供单条直链），再尝试从所有组中提取 .m3u8 或 .mp4 地址
  if (episodes.length === 0) {
    for (const g of urlGroups) {
      const subItems = g.split('#');
      for (const item of subItems) {
        const parts = item.split('$');
        const url = (parts.length >= 2 ? parts[1] : parts[0]).trim();
        const name = (parts.length >= 2 ? parts[0] : `第 ${episodes.length + 1} 集`).trim();
        if (url && (url.includes('.m3u8') || url.includes('.mp4'))) {
          episodes.push({ name, url });
        }
      }
      if (episodes.length > 0) break;
    }
  }

  return episodes;
}

function formatDetail(item, source) {
  return {
    sourceKey: source.key,
    sourceName: source.name,
    vodId: String(item.vod_id),
    name: item.vod_name || '',
    pic: cleanCoverUrl(item.vod_pic || ''),
    type: item.type_name || '',
    year: item.vod_year || '',
    area: item.vod_area || '',
    remarks: item.vod_remarks || '',
    actor: item.vod_actor || '',
    director: item.vod_director || '',
    content: (item.vod_content || '').replace(/<[^>]+>/g, '').trim(),
    episodes: parseEpisodes(item.vod_play_url, item.vod_play_from)
  };
}

/**
 * 云函数入口
 */
exports.main = async (event) => {
  const { action, wd, source, id, listId, pageStart, pageSize } = event;

  try {
    // 0. 容器快速预热 / 健康检测
    if (action === 'ping') {
      return { ok: true, pong: true, timestamp: Date.now() };
    }

    // 0.1 获取影视热榜（支持分页与热度排序）
    if (action === 'getHotList') {
      const targetListId = listId || 'douban_movie_weekly';
      const start = Math.max(0, parseInt(pageStart, 10) || 0);
      const size = Math.min(30, Math.max(1, parseInt(pageSize, 10) || 18));

      const items = await fetchHotListData(targetListId, start, size);
      return {
        ok: true,
        listId: targetListId,
        pageStart: start,
        hasMore: items.length >= size,
        items
      };
    }

    // 1. 获取预置源列表
    if (action === 'getSources') {
      return { ok: true, sources: DEFAULT_SOURCES };
    }

    // 2. 多源聚合搜索（带首源快返机制与单源快速熔断）
    if (action === 'search') {
      if (!wd || !wd.trim()) {
        return { ok: true, list: [] };
      }

      // 每个源超时控制在 2500ms 内，单源慢不阻塞全局
      const searchTasks = DEFAULT_SOURCES.map(async (src) => {
        try {
          const targetUrl = `${src.url.replace(/\/+$/, '')}?ac=detail&wd=${encodeURIComponent(wd.trim())}`;
          const res = await axios.get(targetUrl, {
            headers: UA_HEADERS,
            timeout: 2500
          });
          const list = (res.data && res.data.list) || [];
          return list.map((item) => ({
            sourceKey: src.key,
            sourceName: src.name,
            vodId: String(item.vod_id),
            name: item.vod_name || '',
            pic: cleanCoverUrl(item.vod_pic || ''),
            typeName: item.type_name || '',
            year: item.vod_year || '',
            remarks: item.vod_remarks || ''
          }));
        } catch (err) {
          return [];
        }
      });

      // 并行执行各源查询
      const results = await Promise.all(searchTasks);
      const flattened = results.flat();

      const searchKeyword = wd.trim().toLowerCase();

      // 智能分词与相关性过滤
      const validItems = flattened.filter((item) => {
        if (!item.name) return false;
        const normName = item.name.toLowerCase();
        return normName.includes(searchKeyword);
      });

      const aggregatedMap = new Map();
      for (const item of validItems) {
        const normKey = item.name.toLowerCase().replace(/\s+/g, '');
        if (!aggregatedMap.has(normKey)) {
          let relevance = 0;
          if (normKey === searchKeyword.replace(/\s+/g, '')) {
            relevance = 1000; // 完全精确匹配
          } else if (normKey.startsWith(searchKeyword)) {
            relevance = 500; // 前缀匹配
          } else {
            relevance = Math.max(10, 200 - Math.abs(normKey.length - searchKeyword.length) * 10);
          }

          aggregatedMap.set(normKey, {
            name: item.name,
            pic: item.pic,
            year: item.year,
            typeName: item.typeName,
            relevance,
            sources: []
          });
        }
        const record = aggregatedMap.get(normKey);
        if (!record.pic && item.pic) record.pic = item.pic;
        record.sources.push({
          sourceKey: item.sourceKey,
          sourceName: item.sourceName,
          vodId: item.vodId,
          remarks: item.remarks
        });
      }

      // 按相关度从高到低排序
      const sortedList = Array.from(aggregatedMap.values()).sort((a, b) => b.relevance - a.relevance);

      return {
        ok: true,
        list: sortedList
      };
    }

    // 3. 获取影片详情
    if (action === 'detail') {
      if (!id || !source) {
        return { ok: false, error: '缺少 id 或 source 参数' };
      }
      const matchedSource = DEFAULT_SOURCES.find((s) => s.key === (source.key || source)) || source;
      const targetUrl = `${matchedSource.url.replace(/\/+$/, '')}?ac=videolist&ids=${encodeURIComponent(id)}`;

      const res = await axios.get(targetUrl, {
        headers: UA_HEADERS,
        timeout: 10000
      });
      const list = (res.data && res.data.list) || [];
      if (list.length === 0) {
        return { ok: false, error: '未获取到影片数据' };
      }
      const detail = formatDetail(list[0], matchedSource);
      return { ok: true, data: detail };
    }

    // 4. 视频源并发测速与健康检测 (pingSources)
    if (action === 'pingSources') {
      const { items } = event; // items: [{ sourceKey, vodId, url }]
      if (!Array.isArray(items) || items.length === 0) {
        return { ok: true, speeds: {} };
      }

      const pingTasks = items.map(async (item) => {
        const startTime = Date.now();
        try {
          if (item.url) {
            // 对 m3u8 地址发起 HEAD 请求以检测响应延迟
            await axios.head(item.url, {
              headers: UA_HEADERS,
              timeout: 4000,
              maxRedirects: 3
            });
            return {
              key: item.sourceKey,
              delay: Date.now() - startTime,
              status: 'fast'
            };
          }
          return { key: item.sourceKey, delay: 9999, status: 'unknown' };
        } catch (err) {
          // 若 HEAD 失败或被阻止，尝试通过微量范围请求（Range）探测
          try {
            await axios.get(item.url, {
              headers: { ...UA_HEADERS, Range: 'bytes=0-512' },
              timeout: 3000
            });
            return {
              key: item.sourceKey,
              delay: Date.now() - startTime,
              status: 'normal'
            };
          } catch (e2) {
            return {
              key: item.sourceKey,
              delay: 99999,
              status: 'slow'
            };
          }
        }
      });

      const results = await Promise.all(pingTasks);
      const speeds = {};
      for (const r of results) {
        speeds[r.key] = {
          delay: r.delay,
          tag: r.delay < 800 ? '极速' : r.delay < 2000 ? '流畅' : '一般'
        };
      }
      return { ok: true, speeds };
    }

    return { ok: false, error: '未知 action' };
  } catch (error) {
    console.error('云函数处理异常:', error);
    return { ok: false, error: error.message };
  }
};
