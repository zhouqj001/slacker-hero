/** Typed locale dictionaries for the slacker zone (zh source of truth, en mirror). */

/** Every key this plugin's `slacker` namespace owns. */
export type SlackerKey =
  | 'zone.title'
  | 'zone.motto'
  | 'zone.seal'
  | 'zone.hint'
  | 'zone.boss'
  | 'zone.close'
  | 'zone.min'
  | 'tab.novel'
  | 'tab.game'
  | 'tab.stock'
  | 'tab.zhihu'
  | 'zhihu.title'
  | 'zhihu.needCookie'
  | 'zhihu.cookiePh'
  | 'zhihu.cookieSave'
  | 'zhihu.cookieHint'
  | 'zhihu.cookieBad'
  | 'zhihu.cookieInvalid'
  | 'zhihu.loading'
  | 'zhihu.loadMore'
  | 'zhihu.empty'
  | 'zhihu.readAll'
  | 'zhihu.collapse'
  | 'zhihu.comments'
  | 'zhihu.commentsEmpty'
  | 'zhihu.commentsMore'
  | 'zhihu.commentsFail'
  | 'zhihu.images'
  | 'zhihu.imgHidden'
  | 'zhihu.reset'
  | 'zhihu.clearHistory'
  | 'zhihu.cleared'
  | 'zhihu.error'
  | 'game.2048.title'
  | 'game.2048.score'
  | 'game.2048.best'
  | 'game.2048.new'
  | 'game.2048.over'
  | 'game.2048.hint'
  | 'game.2048.desc'
  | 'game.list.hint'
  | 'game.back'
  | 'game.snake.title'
  | 'game.snake.desc'
  | 'game.snake.score'
  | 'game.snake.best'
  | 'game.snake.new'
  | 'game.snake.over'
  | 'game.snake.paused'
  | 'game.snake.hint'
  | 'game.coming'
  | 'stock.title'
  | 'stock.updated'
  | 'stock.refresh'
  | 'stock.name'
  | 'stock.code'
  | 'stock.price'
  | 'stock.change'
  | 'stock.pct'
  | 'stock.add'
  | 'stock.addBtn'
  | 'stock.remove'
  | 'stock.searchPh'
  | 'stock.searching'
  | 'stock.noResult'
  | 'stock.added'
  | 'stock.mini'
  | 'stock.loading'
  | 'stock.closeDetail'
  | 'stock.pk1'
  | 'stock.pk2'
  | 'stock.pk3'
  | 'stock.pk4'
  | 'stock.pk5'
  | 'stock.pk6'
  | 'stock.pk7'
  | 'stock.adjustQfq'
  | 'stock.adjustHfq'
  | 'stock.adjustNone'
  | 'stock.miniTitle'
  | 'stock.miniPin'
  | 'stock.miniClose'
  | 'stock.miniHint'
  | 'stock.emptyList'
  | 'tea.settingsNav'
  | 'tea.enter'
  | 'tea.ways'
  | 'tea.opacity'
  | 'tea.popupColors'
  | 'tea.popupHint'
  | 'tea.blockTea'
  | 'tea.blockNovel'
  | 'tea.blockGame'
  | 'tea.blockStock'
  | 'tea.blockZhihu'
  | 'tea.colorBg'
  | 'tea.colorFg'
  | 'tea.colorFg2'
  | 'tea.colorAccent'
  | 'tea.colorReset'

/** zh-CN dictionary. */
export const zh = {
  'zone.title': '茶水间',
  'zone.motto': '摸鱼时间',
  'zone.seal': '摸鱼',
  'zone.hint': '收放',
  'zone.boss': '老板键',
  'zone.close': '回到工作',
  'zone.min': '最小化',
  'tab.novel': '小说',
  'tab.game': '游戏',
  'tab.stock': '股票',
  'tab.zhihu': '知乎',
  'zhihu.title': '知乎推荐',
  'zhihu.needCookie': '粘贴知乎 Cookie，开始摸鱼刷推荐（仅存本机）',
  'zhihu.cookiePh': '粘贴整串 Cookie（需含 z_c0 与 d_c0）',
  'zhihu.cookieSave': '保存并加载',
  'zhihu.cookieHint': '浏览器登录知乎 → F12 → Network → 任选请求 → 复制 Request Headers 里的 Cookie 整串',
  'zhihu.cookieBad': 'Cookie 已失效，点右上角「Cookie」更新',
  'zhihu.cookieInvalid': '校验未通过：请完整复制 Cookie（需含 z_c0 与 d_c0）',
  'zhihu.loading': '加载中…',
  'zhihu.loadMore': '继续刷',
  'zhihu.empty': '没有新内容了，稍后再来',
  'zhihu.readAll': '展开全文',
  'zhihu.collapse': '收起',
  'zhihu.comments': '评论',
  'zhihu.commentsEmpty': '还没有评论',
  'zhihu.commentsMore': '更多评论',
  'zhihu.commentsFail': '评论加载失败',
  'zhihu.images': '图',
  'zhihu.imgHidden': '图片已隐藏',
  'zhihu.reset': '换一批',
  'zhihu.clearHistory': '清已读',
  'zhihu.cleared': '已清空',
  'zhihu.error': '加载失败，稍后重试',
  'game.2048.title': '2048',
  'game.2048.score': '本局',
  'game.2048.best': '最高',
  'game.2048.new': '重开一局',
  'game.2048.over': '游戏结束',
  'game.2048.hint': '方向键移动 · R 重开 · 进度落盘，重启不丢',
  'game.2048.desc': '经典数字合成 · 方向键',
  'game.list.hint': '挑一个开始，都在本地跑，进度落盘',
  'game.back': '返回列表',
  'game.snake.title': '贪吃蛇',
  'game.snake.desc': '方向键转向 · 空格暂停',
  'game.snake.score': '本局',
  'game.snake.best': '最高',
  'game.snake.new': '重来一局',
  'game.snake.over': '游戏结束',
  'game.snake.paused': '已暂停',
  'game.snake.hint': '方向键转向 · 空格暂停 · R 重开 · 进度落盘',
  'game.coming': '即将上线',
  'stock.title': '自选行情',
  'stock.updated': '更新于',
  'stock.refresh': '刷新',
  'stock.name': '名称',
  'stock.code': '代码',
  'stock.price': '最新',
  'stock.change': '涨跌',
  'stock.pct': '涨跌幅',
  'stock.add': '输入 6 位代码',
  'stock.addBtn': '＋ 加入',
  'stock.remove': '移出自选',
  'stock.searchPh': '搜索代码 / 名称，回车直接加 6 位代码',
  'stock.searching': '搜索中…',
  'stock.noResult': '没有匹配的 A 股',
  'stock.added': '已在自选',
  'stock.mini': '悬浮窗',
  'stock.loading': '加载中…',
  'stock.closeDetail': '收起',
  'stock.pk1': '日K',
  'stock.pk2': '周K',
  'stock.pk3': '月K',
  'stock.pk4': '5分',
  'stock.pk5': '15分',
  'stock.pk6': '30分',
  'stock.pk7': '60分',
  'stock.adjustQfq': '前复权',
  'stock.adjustHfq': '后复权',
  'stock.adjustNone': '不复权',
  'stock.miniTitle': '自选行情',
  'stock.miniPin': '置顶',
  'stock.miniClose': '关闭',
  'stock.miniHint': '常驻 · 5s 刷新',
  'stock.emptyList': '暂无自选股\n请在主界面添加',
  'tea.settingsNav': '茶水间',
  'tea.enter': '打开茶水间',
  'tea.ways': '托盘「茶水间」菜单 · Alt+M 快速唤出 · 老板键随时隐身',
  'tea.opacity': '阅读弹窗透明度',
  'tea.popupColors': '弹窗配色',
  'tea.popupHint': '每项留空则跟随主题',
  'tea.blockTea': '茶水间',
  'tea.blockNovel': '小说阅读',
  'tea.blockGame': '游戏大厅',
  'tea.blockStock': '自选行情',
  'tea.blockZhihu': '知乎摸鱼',
  'tea.colorBg': '背景',
  'tea.colorFg': '主文字',
  'tea.colorFg2': '次要文字',
  'tea.colorAccent': '强调色',
  'tea.colorReset': '复位（跟随主题）',
} as const satisfies Record<SlackerKey, string>

/** en dictionary. */
export const en = {
  'zone.title': 'Break Room',
  'zone.motto': 'On break',
  'zone.seal': 'on break',
  'zone.hint': 'toggle',
  'zone.boss': 'boss key',
  'zone.close': 'Back to work',
  'zone.min': 'Minimize',
  'tab.novel': 'Novels',
  'tab.game': 'Games',
  'tab.stock': 'Stocks',
  'tab.zhihu': 'Zhihu',
  'zhihu.title': 'Zhihu feed',
  'zhihu.needCookie': 'Paste your Zhihu cookie to start (stored locally only)',
  'zhihu.cookiePh': 'Paste the full cookie string (needs z_c0 & d_c0)',
  'zhihu.cookieSave': 'Save & load',
  'zhihu.cookieHint': 'Sign in on zhihu.com › F12 › Network › any request › copy the Cookie header',
  'zhihu.cookieBad': 'Cookie expired — update it via “Cookie” above',
  'zhihu.cookieInvalid': 'Validation failed: copy the full cookie string (needs z_c0 & d_c0)',
  'zhihu.loading': 'Loading…',
  'zhihu.loadMore': 'More',
  'zhihu.empty': 'Nothing new for now',
  'zhihu.readAll': 'Read more',
  'zhihu.collapse': 'Collapse',
  'zhihu.comments': 'Comments',
  'zhihu.commentsEmpty': 'No comments yet',
  'zhihu.commentsMore': 'More comments',
  'zhihu.commentsFail': 'Failed to load comments',
  'zhihu.images': 'Img',
  'zhihu.imgHidden': 'Image hidden',
  'zhihu.reset': 'Refresh',
  'zhihu.clearHistory': 'Clear read',
  'zhihu.cleared': 'Cleared',
  'zhihu.error': 'Load failed, try later',
  'game.2048.title': '2048',
  'game.2048.score': 'Score',
  'game.2048.best': 'Best',
  'game.2048.new': 'New game',
  'game.2048.over': 'Game over',
  'game.2048.hint': 'Arrow keys · R to restart · progress persists',
  'game.2048.desc': 'Classic tile merging · arrow keys',
  'game.list.hint': 'Pick one — all local, all persisted',
  'game.back': 'Back to list',
  'game.snake.title': 'Snake',
  'game.snake.desc': 'Steer with arrows · space to pause',
  'game.snake.score': 'Score',
  'game.snake.best': 'Best',
  'game.snake.new': 'Restart',
  'game.snake.over': 'Game over',
  'game.snake.paused': 'Paused',
  'game.snake.hint': 'Arrow keys · space to pause · R to restart · progress persists',
  'game.coming': 'Coming soon',
  'stock.title': 'Watchlist',
  'stock.updated': 'Updated',
  'stock.refresh': 'Refresh',
  'stock.name': 'Name',
  'stock.code': 'Code',
  'stock.price': 'Price',
  'stock.change': 'Change',
  'stock.pct': 'Change %',
  'stock.add': 'Enter a 6-digit code',
  'stock.addBtn': '＋ Add',
  'stock.remove': 'Remove',
  'stock.searchPh': 'Search code / name, Enter adds a 6-digit code',
  'stock.searching': 'Searching…',
  'stock.noResult': 'No matching A-share',
  'stock.added': 'In watchlist',
  'stock.mini': 'Mini window',
  'stock.loading': 'Loading…',
  'stock.closeDetail': 'Close',
  'stock.pk1': 'Day',
  'stock.pk2': 'Week',
  'stock.pk3': 'Month',
  'stock.pk4': '5m',
  'stock.pk5': '15m',
  'stock.pk6': '30m',
  'stock.pk7': '60m',
  'stock.adjustQfq': 'Forward adj.',
  'stock.adjustHfq': 'Backward adj.',
  'stock.adjustNone': 'No adj.',
  'stock.miniTitle': 'Watchlist',
  'stock.miniPin': 'Pin',
  'stock.miniClose': 'Close',
  'stock.miniHint': 'Persistent · 5s refresh',
  'stock.emptyList': 'No watchlist items\nAdd them in the main view',
  'tea.settingsNav': 'Break Room',
  'tea.enter': 'Open break room',
  'tea.ways': 'Tray menu › Break Room · Alt+M to toggle · boss key to hide',
  'tea.opacity': 'Reader window opacity',
  'tea.popupColors': 'Popup colors',
  'tea.popupHint': 'Leave blank to follow theme',
  'tea.blockTea': 'Break room',
  'tea.blockNovel': 'Novel reader',
  'tea.blockGame': 'Game center',
  'tea.blockStock': 'Watchlist',
  'tea.blockZhihu': 'Zhihu feed',
  'tea.colorBg': 'Background',
  'tea.colorFg': 'Primary text',
  'tea.colorFg2': 'Secondary text',
  'tea.colorAccent': 'Accent',
  'tea.colorReset': 'Reset (follow theme)',
} as const satisfies Record<SlackerKey, string>
