/** Typed locale dictionaries for the novel plugin (zh source of truth, en mirror). */

/** Every key this plugin's `novel` namespace owns. */
export type NovelKey =
  | 'novel.shelf'
  | 'novel.import'
  | 'novel.delete'
  | 'novel.back'
  | 'novel.catalog'
  | 'novel.settings'
  | 'novel.prev'
  | 'novel.next'
  | 'novel.empty'
  | 'novel.loading'
  | 'novel.notStarted'
  | 'novel.chUnit'
  | 'novel.fontSize'
  | 'novel.lineHeight'
  | 'novel.pageSize'
  | 'novel.theme'
  | 'novel.lineBreak'
  | 'novel.keepBreak'
  | 'novel.mergeBreak'
  | 'novel.pagingKeys'
  | 'novel.pagingNext'
  | 'novel.pagingPrev'
  | 'novel.pagingNextTitle'
  | 'novel.pagingPrevTitle'
  | 'novel.pagingDefault'
  | 'novel.floatTextColor'
  | 'novel.floatTextFont'
  | 'novel.floatFontSize'
  | 'novel.floatBgColor'
  | 'novel.floatOpacity'
  | 'novel.font.yahei'
  | 'novel.font.serif'
  | 'novel.font.mono'
  | 'novel.disguise'
  | 'novel.disguise.none'
  | 'novel.disguise.dark'
  | 'novel.disguise.float'
  | 'novel.floatHint'
  | 'novel.badge.net'
  | 'novel.badge.local'
  | 'novel.opacity'
  | 'novel.autoStealth'
  | 'novel.bossKey'
  | 'novel.close'
  | 'novel.on'
  | 'novel.off'
  | 'novel.theme.dark'
  | 'novel.theme.parchment'
  | 'novel.theme.green'
  | 'novel.theme.ink'
  | 'novel.theme.white'
  | 'novel.time.now'
  | 'novel.time.min'
  | 'novel.time.hour'
  | 'novel.time.day'
  | 'novel.tab.shelf'
  | 'novel.tab.search'
  | 'novel.tab.sources'
  | 'novel.search.placeholder'
  | 'novel.search.btn'
  | 'novel.search.multi'
  | 'novel.search.searching'
  | 'novel.search.empty'
  | 'novel.search.nosrc'
  | 'novel.search.read'
  | 'novel.search.added'
  | 'novel.search.add2shelf'
  | 'novel.search.detail'
  | 'novel.net.loading'
  | 'novel.net.fail'
  | 'novel.src.import'
  | 'novel.src.paste.ph'
  | 'novel.src.file'
  | 'novel.src.empty'
  | 'novel.src.del'
  | 'novel.src.enabled'
  | 'novel.src.disabled'
  | 'novel.src.imported'
  | 'novel.src.skipped'
  | 'novel.search.back'
  | 'novel.search.category'
  | 'novel.search.noCat'
  | 'novel.search.recent'
  | 'novel.search.recentEmpty'
  | 'novel.search.manage'
  | 'novel.search.total'
  | 'novel.search.download'
  | 'novel.search.downloading'
  | 'novel.search.saved'
  | 'novel.search.failed'
  | 'novel.search.retry'
  | 'novel.net.srcGone'
  | 'novel.dl.list'
  | 'novel.dl.badge'
  | 'novel.dl.empty'
  | 'novel.dl.queued'
  | 'novel.dl.downloading'
  | 'novel.dl.done'
  | 'novel.dl.error'
  | 'novel.dl.retry'
  | 'novel.dl.clear'
  | 'novel.dl.unknown'
  | 'novel.dlDir'
  | 'novel.dlDir.cur'
  | 'novel.dlDir.browse'
  | 'novel.dlDir.ph'
  | 'novel.dlDir.set'
  | 'novel.dlDir.reset'
  | 'novel.dlDir.saved'
  | 'novel.dlDir.fail'
  | 'novel.settings.general'
  | 'novel.settings.disguise'
  | 'novel.settings.storage'

/** zh-CN dictionary. */
export const zh = {
  'novel.shelf': '书架',
  'novel.import': '导入 TXT',
  'novel.delete': '移出书架',
  'novel.back': '← 书架',
  'novel.catalog': '目录',
  'novel.settings': '设置',
  'novel.prev': '上一页',
  'novel.next': '下一页',
  'novel.empty': '书架空空的，导入一本 TXT 开始',
  'novel.loading': '正在解析…',
  'novel.notStarted': '未读',
  'novel.chUnit': '章',
  'novel.fontSize': '字号',
  'novel.lineHeight': '行距',
  'novel.pageSize': '每页字数',
  'novel.theme': '主题',
  'novel.lineBreak': '换行',
  'novel.keepBreak': '保留换行',
  'novel.mergeBreak': '合并段落',
  'novel.pagingKeys': '翻页键',
  'novel.pagingNext': '下一页',
  'novel.pagingPrev': '上一页',
  'novel.pagingNextTitle': '点击后按一个键，设为"下一页"',
  'novel.pagingPrevTitle': '点击后按一个键，设为"上一页"',
  'novel.pagingDefault': '默认',
  'novel.floatTextColor': '浮条文字颜色',
  'novel.floatTextFont': '浮条文字字体',
  'novel.floatFontSize': '浮条文字大小',
  'novel.floatBgColor': '浮条背景颜色',
  'novel.floatOpacity': '浮条背景不透明度',
  'novel.font.yahei': '雅黑',
  'novel.font.serif': '衬线',
  'novel.font.mono': '等宽',
  'novel.disguise': '伪装皮肤',
  'novel.disguise.none': '无',
  'novel.disguise.dark': '黑底纯正文',
  'novel.disguise.float': '悬浮',
  'novel.floatHint': 'Ctrl+Alt+←/→ 翻页',
  'novel.badge.net': '网络',
  'novel.badge.local': '本地',
  'novel.opacity': '透明度',
  'novel.autoStealth': '失焦自动隐身',
  'novel.bossKey': '老板键（隐身）',
  'novel.close': '关闭',
  'novel.on': '开',
  'novel.off': '关',
  'novel.theme.dark': '暗夜',
  'novel.theme.parchment': '羊皮纸',
  'novel.theme.green': '护眼绿',
  'novel.theme.ink': '水墨',
  'novel.theme.white': '极简白',
  'novel.time.now': '刚刚',
  'novel.time.min': '分钟前',
  'novel.time.hour': '小时前',
  'novel.time.day': '天前',
  'novel.tab.shelf': '书架',
  'novel.tab.search': '搜索',
  'novel.tab.sources': '书源',
  'novel.search.placeholder': '书名 / 作者',
  'novel.search.btn': '搜索',
  'novel.search.multi': '多源并发',
  'novel.search.searching': '搜索中…',
  'novel.search.empty': '没有结果，换个关键词试试',
  'novel.search.nosrc': '还没有可用书源，先到「书源」页导入',
  'novel.search.read': '阅读',
  'novel.search.added': '已在书架',
  'novel.search.add2shelf': '＋ 书架',
  'novel.search.detail': '详情加载中…',
  'novel.net.loading': '正在抓取本章…',
  'novel.net.fail': '章节抓取失败',
  'novel.src.import': '导入书源',
  'novel.src.paste.ph': '粘贴书源 JSON（v2 或 Legado 格式）…',
  'novel.src.file': '选择文件',
  'novel.src.empty': '还没有书源，粘贴或选择文件导入（支持 Legado 自动转换）',
  'novel.src.del': '删除',
  'novel.src.enabled': '已启用',
  'novel.src.disabled': '已停用',
  'novel.src.imported': '已导入',
  'novel.src.skipped': '跳过',
  'novel.search.back': '← 返回',
  'novel.search.category': '分类',
  'novel.search.noCat': '该书源未提供分类浏览',
  'novel.search.recent': '最近阅读',
  'novel.search.recentEmpty': '暂无',
  'novel.search.manage': '管理书源',
  'novel.search.total': '共 {n} 章',
  'novel.search.download': '下载全书',
  'novel.search.downloading': '下载中…',
  'novel.search.saved': '已保存到书架',
  'novel.search.failed': '下载失败',
  'novel.search.retry': '重试',
  'novel.net.srcGone': '书源已删除，无法下载',
  'novel.dl.list': '下载列表',
  'novel.dl.badge': '下载',
  'novel.dl.empty': '暂无下载任务',
  'novel.dl.queued': '排队中',
  'novel.dl.downloading': '下载中',
  'novel.dl.done': '完成',
  'novel.dl.error': '失败',
  'novel.dl.retry': '重试',
  'novel.dl.clear': '清空已完成',
  'novel.dl.unknown': '未知',
  'novel.dlDir': '下载目录',
  'novel.dlDir.cur': '当前目录',
  'novel.dlDir.browse': '浏览',
  'novel.dlDir.ph': 'C:\\Novels',
  'novel.dlDir.set': '保存',
  'novel.dlDir.reset': '恢复默认',
  'novel.dlDir.saved': '已保存',
  'novel.dlDir.fail': '保存失败',
  'novel.settings.general': '通用设置',
  'novel.settings.disguise': '伪装外观',
  'novel.settings.storage': '小说存放',
} as const satisfies Record<NovelKey, string>

/** en dictionary. */
export const en = {
  'novel.shelf': 'Shelf',
  'novel.import': 'Import TXT',
  'novel.delete': 'Remove',
  'novel.back': '← Shelf',
  'novel.catalog': 'Contents',
  'novel.settings': 'Settings',
  'novel.prev': 'Prev',
  'novel.next': 'Next',
  'novel.empty': 'Shelf is empty — import a TXT to start',
  'novel.loading': 'Parsing…',
  'novel.notStarted': 'Not started',
  'novel.chUnit': 'chapters',
  'novel.fontSize': 'Font size',
  'novel.lineHeight': 'Line height',
  'novel.pageSize': 'Chars/page',
  'novel.theme': 'Theme',
  'novel.lineBreak': 'Line break',
  'novel.keepBreak': 'Keep breaks',
  'novel.mergeBreak': 'Merge paragraphs',
  'novel.pagingKeys': 'Paging keys',
  'novel.pagingNext': 'Next page',
  'novel.pagingPrev': 'Prev page',
  'novel.pagingNextTitle': 'Click then press a key to set "next page"',
  'novel.pagingPrevTitle': 'Click then press a key to set "prev page"',
  'novel.pagingDefault': 'Default',
  'novel.floatTextColor': 'Float text color',
  'novel.floatTextFont': 'Float text font',
  'novel.floatFontSize': 'Float text size',
  'novel.floatBgColor': 'Float bg color',
  'novel.floatOpacity': 'Float bg opacity',
  'novel.font.yahei': 'YaHei',
  'novel.font.serif': 'Serif',
  'novel.font.mono': 'Mono',
  'novel.disguise': 'Disguise',
  'novel.disguise.none': 'None',
  'novel.disguise.dark': 'Dark plain',
  'novel.disguise.float': 'Float',
  'novel.floatHint': 'Ctrl+Alt+←/→ to page',
  'novel.badge.net': 'Online',
  'novel.badge.local': 'Local',
  'novel.opacity': 'Opacity',
  'novel.autoStealth': 'Auto-stealth on blur',
  'novel.bossKey': 'Boss key',
  'novel.close': 'Close',
  'novel.on': 'On',
  'novel.off': 'Off',
  'novel.theme.dark': 'Night',
  'novel.theme.parchment': 'Parchment',
  'novel.theme.green': 'Sepia green',
  'novel.theme.ink': 'Ink',
  'novel.theme.white': 'Plain white',
  'novel.time.now': 'just now',
  'novel.time.min': 'min ago',
  'novel.time.hour': 'h ago',
  'novel.time.day': 'd ago',
  'novel.tab.shelf': 'Shelf',
  'novel.tab.search': 'Search',
  'novel.tab.sources': 'Sources',
  'novel.search.placeholder': 'Title / author',
  'novel.search.btn': 'Search',
  'novel.search.multi': 'multi-source',
  'novel.search.searching': 'Searching…',
  'novel.search.empty': 'No results — try another keyword',
  'novel.search.nosrc': 'No book sources yet — import some on the "Sources" tab',
  'novel.search.read': 'Read',
  'novel.search.added': 'On shelf',
  'novel.search.add2shelf': '+ Shelf',
  'novel.search.detail': 'Loading details…',
  'novel.net.loading': 'Fetching chapter…',
  'novel.net.fail': 'Failed to fetch chapter',
  'novel.src.import': 'Import sources',
  'novel.src.paste.ph': 'Paste book-source JSON (v2 or Legado)…',
  'novel.src.file': 'Choose file',
  'novel.src.empty': 'No sources yet — paste or pick a file to import (Legado auto-converted)',
  'novel.src.del': 'Delete',
  'novel.src.enabled': 'Enabled',
  'novel.src.disabled': 'Disabled',
  'novel.src.imported': 'Imported',
  'novel.src.skipped': 'Skipped',
  'novel.search.back': '← Back',
  'novel.search.category': 'Categories',
  'novel.search.noCat': 'This source does not offer category browsing',
  'novel.search.recent': 'Recent reads',
  'novel.search.recentEmpty': 'None',
  'novel.search.manage': 'Manage sources',
  'novel.search.total': '{n} chapters',
  'novel.search.download': 'Download book',
  'novel.search.downloading': 'Downloading…',
  'novel.search.saved': 'Saved to shelf',
  'novel.search.failed': 'Download failed',
  'novel.search.retry': 'Retry',
  'novel.net.srcGone': 'Book source removed — cannot download',
  'novel.dl.list': 'Downloads',
  'novel.dl.badge': 'Downloads',
  'novel.dl.empty': 'No download tasks',
  'novel.dl.queued': 'Queued',
  'novel.dl.downloading': 'Downloading',
  'novel.dl.done': 'Done',
  'novel.dl.error': 'Failed',
  'novel.dl.retry': 'Retry',
  'novel.dl.clear': 'Clear finished',
  'novel.dl.unknown': 'Unknown',
  'novel.dlDir': 'Download folder',
  'novel.dlDir.cur': 'Current',
  'novel.dlDir.browse': 'Browse',
  'novel.dlDir.ph': 'C:\\Novels',
  'novel.dlDir.set': 'Save',
  'novel.dlDir.reset': 'Reset default',
  'novel.dlDir.saved': 'Saved',
  'novel.dlDir.fail': 'Save failed',
  'novel.settings.general': 'General',
  'novel.settings.disguise': 'Disguise',
  'novel.settings.storage': 'Storage',
} as const satisfies Record<NovelKey, string>
