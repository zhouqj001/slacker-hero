/**
 * 写作风格层（计划 §11.1/§11.2）：
 *   - WRITING_DOCTRINE：写作教义，只管「写什么」（不确定性原则），
 *     注入所有生成类 prompt 置顶（文风卡之前）。
 *   - ARCHETYPES：内置风格原型库，管「怎么写」——每原型 = 结构化指令块
 *     + few-shot 段落 + 指纹参数（供 quality.ts 粗筛按原型调阈值）。
 *   - prompt 构建器：教义块 / 原型块 / 去AI味硬约束块，供 llm.ts 四层装配。
 * 纯常量与纯函数，零依赖（勿引入 llm.ts/domain.ts，避免环）。
 */

/**
 * 写作教义·最高优先级（§11.1 全文）。所有生成类 prompt（向导/续排/开新卷/
 * 章节/改写/审稿校准）置顶注入。教义只规定「写什么」，不管「怎么写」。
 */
export const WRITING_DOCTRINE = `【写作教义·最高优先级】
你在写通俗小说。唯一标准：设计有意义的不确定性，让读者上瘾、舍不得。

- 每 500 字回头检查：这一段有没有创造新的不确定？没有，删掉重写。
  做好这一件事就足够拿 80 分；人物弧光、主题深度是 80 分以上的事，
  考虑多了反而降分，本章你只对不确定性负责。
- 承诺与回收：作者承诺会发生什么，读者沿草蛇灰线追过去，陷入
  「有意义的不确定」。读者追到最后几章反而不敢看——他们舍不得的
  是不确定的沉浸感，比你的承诺本身更重要。埋了就要回收（伏笔账）。
- 落地细节优先：具体名词、可感知动作、反常细节。
  不要写「传说中的东方巨龙盘踞山巅」；要写
  「它还欠我五块钱」「它顺走了我的拖鞋，再见到时脚上穿着老子的拖鞋」。
  读者不想知道龙的鳞片是不是 3D 渲染的。
- 入口即事件：删掉铺垫，让冲突或反常在第一段发生。
  主角在殡仪馆门口抽烟，手机响了——三年前被他自己用水泥封进桥墩的
  前女友发来四个字：「水泥太凉」。从此他吃一碗米粉读者都盯着看有没有骨灰。
- 不确定性 ≠ 只有悬念钩子：信息差（读者知道而角色不知道，或反过来）、
  想要而得不到、两难抉择、反常细节（不该出现的东西出现了）都算。
  「他不知道的是……」这类套路一章最多用一次。`

/** 原型指纹：quality.ts 程序粗筛的阈值全部由此参数化（不同原型不同人味）。 */
export interface ArchetypeFingerprint {
  /** 口语标记（嘛/呗/得了/你猜…）每千字参考区间 [min, max]。 */
  colloquialPer1k: [number, number]
  /** 每千字具象细节（精确数字/实物/地名）数量下限。 */
  concreteDetailPer1kMin: number
  /** 全章句长（字）标准差下限：低于即「句长均匀」= 典型 AI 特征。 */
  sentenceLenStdMin: number
  /** 段末升华（总结腔收段）允许段数。通俗小说一律 0。 */
  endingSublimationMax: number
  /** 段落长度变异系数（标准差/均值）下限：过低 = 段落等长。 */
  paraCvMin: number
}

/** 风格原型：「怎么写」的可选类型。建书向导按题材推荐，可换。 */
export interface Archetype {
  id: string
  name: string
  /** 谱系（供人理解，不进 prompt）。 */
  lineage: string
  /** 适用题材关键词（向导推荐用）。 */
  genres: string[]
  /** 结构化指令块（进 prompt 的「怎么写」层）。 */
  instruction: string
  /** few-shot 正例段（对白与细节的「人味」锚点）。 */
  fewShot: string
  fingerprint: ArchetypeFingerprint
}

/** 毒舌老炮体：参考样本判型（互联网口语干货体 × 毒舌老炮说书体）。 */
const SHARP_TONGUE: Archetype = {
  id: 'sharp-tongue',
  name: '毒舌老炮体',
  lineage: '互联网口语干货体 × 毒舌老炮说书体',
  genres: ['都市', '现实', '职场', '江湖', '历史'],
  instruction: `【风格原型·毒舌老炮体】怎么写听这里的：
- 口语底色：像茶馆里见过世面的老炮在给你讲他亲身经历，不是在写文章。
- 具象锚点密集：精确数字 + 实物 + 地名。不说「很穷」，说「余额四十七块三」；
  不说「老城区」，说「红旗巷自来水站旁边那个门脸」。
- 粗口做情绪节拍器：低度粗口（「他妈的」「老子」）只在情绪鼓点上出现，
  一段最多一处，别当标点用。
- 自嘲与毒舌：叙述者对世界毒舌、对自己更毒；绝对化断言允许（「那条街
  没人不知道」），但每处断言后面最好跟一个细节撑腰。
- 单句成段做顿悟句：全文最多两三处，用在揭示处，别当节奏依赖。
- 章末反升华：禁止总结、禁止点题、禁止抒情。收在动作、对话或反常细节上。`,
  fewShot: `正例（体会即可，禁止照抄情节）：
「那龙蹲在山巅？扯淡。它蹲在菜市场口，蹲了三年，就为等卖鱼老陈收摊——
它欠老陈五块钱，三年没还。后来老陈死了，龙把摊子上那杆秤叼走了。
再有人看见它，秤盘里躺着五枚一块的硬币，锈的。
它顺走我的拖鞋那回我乐了——再见到时，它脚上穿着老子的拖鞋。」`,
  fingerprint: {
    colloquialPer1k: [4, 14],
    concreteDetailPer1kMin: 5,
    sentenceLenStdMin: 6,
    endingSublimationMax: 0,
    paraCvMin: 0.35,
  },
}

/** 白描冷面体：零度叙述，情绪全藏进动作。 */
const DEADPAN: Archetype = {
  id: 'deadpan',
  name: '白描冷面体',
  lineage: '余华/阿城谱系',
  genres: ['悬疑', '推理', '惊悚', '正剧', '刑侦'],
  instruction: `【风格原型·白描冷面体】怎么写听这里的：
- 零度叙述：作者不存在，不评论、不感叹、不解释。情绪一个字都不许写，
  全部藏进动作和物件里——「他把烟摁灭了，又点了一根」就是恐惧。
- 短句为主：主谓宾，砍掉修饰。长句只在需要拖住读者呼吸时出现。
- 对话短促：人物不把话说满，答非所问、沉默、转移话题都是对话。
- 细节做证物：每个具象细节都要么推进事件，要么埋不确定，二者之外的删掉。
- 章末反升华：收在一个动作或一句短对话上。禁止任何形式的总结。`,
  fewShot: `正例（体会即可，禁止照抄情节）：
「锅里的水开了。她没动。
水漫出来，浇灭了灶上的火。她还是没动。
桌上摆着两副碗筷。她丈夫出差第九天。
门口的鞋架上，多了一双泥鞋。三十七码。她丈夫四十二。」`,
  fingerprint: {
    colloquialPer1k: [0, 4],
    concreteDetailPer1kMin: 4,
    sentenceLenStdMin: 4,
    endingSublimationMax: 0,
    paraCvMin: 0.3,
  },
}

/** 生活流唠嗑体：市井对话密集，吐槽内嵌。 */
const CHATTER: Archetype = {
  id: 'chatter',
  name: '生活流唠嗑体',
  lineage: '王朔/老帖谱系',
  genres: ['轻喜剧', '都市', '日常', '家庭', '校园'],
  instruction: `【风格原型·生活流唠嗑体】怎么写听这里的：
- 对话密集：一章过半是说话。人物抢话、打岔、接下茬，话没说完被
  另一件事岔开是常态。但每次对话都要留下新的不确定，不许纯闲篇。
- 吐槽内嵌：叙述里带损人的括号与补刀，损完就走，不解释笑点。
- 流水但不平：事件按生活流推进，但每几百字必须沉一块石头
  （反常/信息差/两难），表面越松弛，水底下越紧。
- 细节市井化：物价、菜价、公交路线、小区门口的狗。数字要具体到毛。
- 章末反升华：禁止感悟人生。收在一句没说完的话或一个新出现的麻烦上。`,
  fewShot: `正例（体会即可，禁止照抄情节）：
「『你跟我妈说什么了？』
『没说什么。』老周把韭菜往袋子里装，『就问了句阿姨身体。』
『她中午给我发了六十秒语音。』
『那可能问了点别的。』
我妈的语音我还没点开。六十秒，她上回发六十秒，是我爸住院那天。
老周已经拎着韭菜走远了，走得特别快，像一个刚干完坏事的人。」`,
  fingerprint: {
    colloquialPer1k: [8, 20],
    concreteDetailPer1kMin: 4,
    sentenceLenStdMin: 5,
    endingSublimationMax: 0,
    paraCvMin: 0.3,
  },
}

/** 内置原型库（key = book.archetype 存的 id）。 */
export const ARCHETYPES: Record<string, Archetype> = {
  [SHARP_TONGUE.id]: SHARP_TONGUE,
  [DEADPAN.id]: DEADPAN,
  [CHATTER.id]: CHATTER,
}

/** 原型 id 列表（顺序即 UI 展示顺序）。 */
export const ARCHETYPE_IDS = [SHARP_TONGUE.id, DEADPAN.id, CHATTER.id]

/**
 * 按题材关键词推荐原型（向导提案用；无命中回落毒舌老炮体——
 * 通俗网文最稳的底色）。genre 形如「都市」「悬疑+刑侦」。
 */
export function recommendArchetype(genre: string): string {
  const g = genre || ''
  for (const a of [DEADPAN, CHATTER]) {
    if (a.genres.some((k) => g.includes(k))) return a.id
  }
  return SHARP_TONGUE.id
}

/**
 * 取书所选原型；未选（一期旧书）返回 null = 走一期通用腔
 * （DEFAULT_STYLE_CARD 兜底，不强行套原型）。
 */
export function resolveArchetype(id: string | undefined | null): Archetype | null {
  if (!id) return null
  return ARCHETYPES[id] ?? null
}

/** 教义 + 原型拼成一个 prompt 块（教义在前）。原型缺省只出教义。 */
export function buildDoctrineBlock(archetype: Archetype | null): string {
  const parts = [WRITING_DOCTRINE]
  if (archetype) {
    parts.push('', archetype.instruction, '', archetype.fewShot)
  }
  return parts.join('\n')
}

/** 原型轻量摘要（client 选择 UI 用；不暴露 prompt/few-shot 内部层）。 */
export function archetypeSummaries(): { id: string; name: string; lineage: string; genres: string[] }[] {
  return ARCHETYPE_IDS.map((id) => {
    const a = ARCHETYPES[id]!
    return { id: a.id, name: a.name, lineage: a.lineage, genres: [...a.genres] }
  })
}

/**
 * 去 AI 味·硬约束清单（§11.2 四层禁令，阈值随原型指纹参数化）。
 * 词表本体在 quality.ts（程序粗筛同源）；这里给生成侧的禁令文本。
 */
export function buildAiFlavorConstraints(a: Archetype | null): string {
  const stdMin = a?.fingerprint.sentenceLenStdMin ?? 5
  const detailMin = a?.fingerprint.concreteDetailPer1kMin ?? 4
  return `【去 AI 味·硬约束（违反任何一条即废稿）】
1. 禁词：仿佛、似乎、一丝、不禁、心中一紧、眼底闪过、嘴角勾起、
   空气凝固、莫名的、某种……的……——以及一切同族书面套话。
2. 句式：禁止连续 3 个结构相同的短句/短语（排比三连）；段落长短要有
   参差，全章句长波动要大（心里指标：标准差 ≥ ${stdMin} 字，别真去数，
   写完自己念一遍，念着平就砸碎了重拼）。
3. 对话：不许两个人礼貌地轮流说完整句子。要有打断、省略、答非所问、
   说一半被岔开。不同人不同腔调——身份、年龄、地方口音要能从台词分辨。
4. 情感：禁止直接命名情绪（他很愤怒/她感到悲伤/空气里满是尴尬）。
   用动作、物件、生理反应传达。
5. 细节密度：每千字至少 ${detailMin} 个具象细节（精确数字/实物/地名）。
   抽象形容不算数。
6. 章末：禁止总结、禁止点题、禁止升华。收在动作、对话或反常细节上，
   让读者带着问题翻下一章。`
}
