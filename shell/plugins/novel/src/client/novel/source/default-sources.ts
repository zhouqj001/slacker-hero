/**
 * 内置默认书源 —— 主应用 booksource/default-sources.ts 的移植。
 *
 * 首次运行时（书源为空且未 seed 过）灌入，让「在线搜索」开箱可用。
 * ⚠️ 社区公开源，DOM 可能随时调整、不保证永远可用；可在「书源」页删除替换。
 */
import type { BookSource } from './types.ts'

export const DEFAULT_SOURCES: BookSource[] = [
  {
    schema: 'trnovel-booksource/v2',
    name: '默认书源（公网镜像·待校验）',
    url: 'https://www.biquge.com.cn',
    http: {
      charset: 'auto',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
    },
    search: {
      request: {
        url: '{{base}}/search?q={{key}}&page={{page}}',
        method: 'GET',
      },
      list: {
        via: 'css',
        select: '.result-item, .search-item, .book-item',
        item: {
          name: { via: 'css', select: 'h3, .name, a[title]' },
          bookUrl: { via: 'css', select: 'a', extract: { attr: 'href' } },
          author: { via: 'css', select: '.author, .writer', extract: 'text' },
          cover: { via: 'css', select: 'img', extract: { attr: 'src' } },
          intro: { via: 'css', select: '.intro, .desc, p', extract: 'text' },
        },
      },
    },
    bookInfo: {
      name: { via: 'css', select: 'h1, .book-name, .title', extract: 'text' },
      author: { via: 'css', select: '.author, .writer', extract: 'text' },
      cover: { via: 'css', select: '.book-cover img, img.cover', extract: { attr: 'src' } },
      intro: { via: 'css', select: '.intro, .book-desc, .description', extract: 'text' },
    },
    toc: {
      list: {
        via: 'css',
        select: '.chapter-list a, #list a, .catalog a',
        item: {
          name: { via: 'css', select: 'a', extract: 'text' },
          url: { via: 'css', select: 'a', extract: { attr: 'href' } },
        },
      },
    },
    content: {
      request: { url: '{{chapterUrl}}', method: 'GET', charset: 'auto' },
      value: {
        via: 'firstOf',
        rules: [
          { via: 'css', select: '#content, .content, .chapter-content', extract: 'html' },
          { via: 'css', select: '#chaptercontent, .read-content, .pt-content', extract: 'html' },
        ],
      },
    },
    samples: [],
  },
]