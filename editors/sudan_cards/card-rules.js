/**
 * The card rules this editor checks against, written so the page can run them in the sandbox.
 *
 * The iframe may load scripts only from its own directory, so it cannot import `schema/` or
 * `tools/lint.mjs` at run time. These lists are copies, and `script/editor-tool.test.mjs` fails
 * when a copy and its source disagree:
 *
 *   CARD_FIELDS / CARD_LEGACY   schema/fields.json, kind `card`
 *   CARD_TYPES / RARE_MIN / RARE_MAX   tools/lint.mjs (`CARD_TYPE`, `CARD_RARE`)
 *   TAG_STAT / TAG_MARKER       schema/tag-roles.json, which was read off all shipped cards
 *
 * Every message names the key it is about, because the player fixes the value, not the rule.
 */

export const CARD_FIELDS = [
  "id",
  "name",
  "title",
  "text",
  "pops",
  "type",
  "rare",
  "resource",
  "destroy_resources",
  "tag",
  "card_vanishing",
  "vanish",
  "equips",
  "is_only",
  "sfx",
  "post_rite",
];

/** Keys vanilla writes that no field backs: lint warns, so a save is not blocked. */
export const CARD_LEGACY = ["card_favour", "tips"];

export const CARD_TYPES = ["char", "item", "sudan"];
export const RARE_MIN = 1;
export const RARE_MAX = 4;

/** A stat tag carries a number; the range is what the shipped cards use. */
export const TAG_STAT = {
  体魄: { min: -3, max: 99 },
  战斗: { min: -1, max: 99 },
  魅力: { min: -10, max: 11 },
  智慧: { min: -5, max: 10 },
  魔力: { min: 1, max: 99 },
  生存: { min: -3, max: 20 },
  社交: { min: -5, max: 10 },
  隐匿: { min: -1, max: 10 },
  重投: { min: 1, max: 8 },
  反对: { min: 1, max: 3 },
  支持: { min: 1, max: 3 },
  命运点: { min: 1, max: 4 },
  深度: { min: 1, max: 4 },
  价值: { min: 2, max: 10 },
  身价: { min: 1, max: 12 },
  改革: { min: 2, max: 3 },
  传统: { min: 2, max: 4 },
  追随者: { min: -1, max: 1 },
  犯罪号召: { min: 1, max: 2 },
  灵感: { min: 20, max: 20 },
};

/** A marker tag is present or absent, so its value is 1 in every shipped use. */
export const TAG_MARKER = new Set([
  "纯色材质", "已拥有", "装备", "已装备", "可堆叠", "读物", "银趴绝缘者", "男性", "饰品", "消耗品", "部队", "贵族",
  "武器", "女性", "食客", "有跟班", "怪物", "装备商人", "大餐", "服装", "情报", "动物", "苏丹卡", "思潮", "驯兽",
  "恶名谋杀者", "秘宝", "宝石", "地点", "天象", "爱书人", "妆扮", "黑暗知识", "任意处置", "部落遗物", "空屋",
  "苏丹的精兵", "苏丹的近卫", "奴隶", "奇珍", "坐骑", "囚徒", "恶名挑战者", "墓碑", "小颗", "大颗", "黑街居民",
  "耐心", "装潢", "情诗", "史诗", "小筹", "描边", "将领", "金色文字", "杀戮", "纵欲", "奢靡", "征服", "讽刺诗",
  "预言诗", "倒计时", "主角", "弓箭", "破除封锁", "租赁协议", "邪神的面容", "正神的面容", "孤儿", "梅姬", "妻子",
  "命运的羁绊", "金币", "妓女", "食物", "激情", "专属", "关闭", "未被苏丹所知", "主角专属2", "主角专属1", "法拉杰",
  "妖精", "爱", "信", "智", "力", "乐", "金血之证", "小筹征服", "异国商人", "正教的信徒", "盖斯", "哲瓦德", "小偷",
  "淫具", "未鉴定", "魔力戒指", "犯罪计划", "神器", "玛瑙", "红玉髓", "紫水晶", "祖母绿", "红宝石", "蓝宝石", "钻石",
  "热娜", "密教徒", "苏丹专属", "苏丹", "影响力", "污名", "法图娜", "扎齐伊", "不满", "恶名", "受伤", "诅咒", "镜子",
  "谗言", "主旋律", "黑街声望", "生病", "抑郁", "书店老板", "鳄鱼", "疯狂", "宰相", "质子", "锁定穆尔台兹", "主角专属3",
  "主角专属4", "主角专属5", "小薇", "小安", "小留", "令人开心的妆扮", "抱猫人", "魅力护符", "生命权杖", "罪证",
  "蓄谋", "奈费勒的优势", "铁头的优势", "免疫", "猜忌", "军队的好感", "国民的好感", "官吏的好感", "赤字",
  "不举的传言", "娜依拉的不满", "火焰大王", "芮尔", "哲瓦德的优势", "蒙面苏丹", "苏丹的怒火", "信誉", "善名的遮掩",
  "权势的遮掩", "侠名的遮掩", "灵视的遮掩", "被覆者", "回应誓言", "淬毒", "冤魂", "正当性", "尸体", "被囚禁",
  "被流放", "被侮辱的", "承阳", "芮尔手下", "新月", "剑客蓄势", "避孕套", "锁定祭司", "伊曼的残留", "正教的乙太",
  "变革戒", "生命之心", "毒蛇之链", "欲蛇之纱", "纯洁之纱", "群星戒", "小筹的金币", "挖矿奴隶", "妖精女王", "疲劳",
  "羊肉炉", "羊肉炉飞升进度", "飞升的阶梯", "虚空护盾", "造物的工具", "第一推动力", "传说地点",
]);

/** How the editor draws one tag: a ranged number, a fixed 1, or a name the page cannot judge. */
export function tagKind(name) {
  if (Object.prototype.hasOwnProperty.call(TAG_STAT, name)) return "stat";
  return TAG_MARKER.has(name) ? "marker" : "unknown";
}

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * Check one card the way `tools/lint.mjs` checks a `config/cards.json` entry.
 * An error blocks the save; a warning is shown and saved through, which is what lint does.
 */
export function validateCard(id, card) {
  const errors = [];
  const warnings = [];
  if (!isObject(card)) {
    errors.push(`卡 ${id} 不是一个对象。`);
    return { errors, warnings };
  }

  for (const key of Object.keys(card)) {
    if (CARD_FIELDS.includes(key)) continue;
    if (CARD_LEGACY.includes(key)) {
      warnings.push(`卡 ${id} 的 \`${key}\` 是历史键，游戏没有对应字段读它。`);
      continue;
    }
    errors.push(`卡 ${id} 有未知键 \`${key}\`，游戏按字段名读卡，这个名字没有字段对应。`);
  }

  for (const key of ["id", "name", "type", "rare"]) {
    if (card[key] === undefined) warnings.push(`卡 ${id} 没有 \`${key}\`。`);
  }
  if (card.type !== undefined && !CARD_TYPES.includes(card.type)) {
    errors.push(`卡 ${id} 的 \`type\` 是 \`${card.type}\`，只能写 \`char\`、\`item\` 或 \`sudan\`。`);
  }
  if (typeof card.rare === "number" && !(card.rare >= RARE_MIN && card.rare <= RARE_MAX)) {
    errors.push(`卡 ${id} 的 \`rare\` 是 ${card.rare}，只有 ${RARE_MIN}–${RARE_MAX}。`);
  }
  if (typeof card.card_vanishing === "number" && card.card_vanishing < 0) {
    errors.push(`卡 ${id} 的 \`card_vanishing\` 是 ${card.card_vanishing}，0 表示永不老死，不写负数。`);
  }

  if (card.tag !== undefined && !isObject(card.tag)) {
    errors.push(`卡 ${id} 的 \`tag\` 必须是「标签名 -> 数字」的对象。`);
  } else if (isObject(card.tag)) {
    for (const [name, level] of Object.entries(card.tag)) {
      if (typeof level !== "number" || !Number.isFinite(level)) {
        errors.push(`卡 ${id} 的标签 \`${name}\` 不是数字。`);
        continue;
      }
      const kind = tagKind(name);
      if (kind === "marker" && level !== 1) {
        errors.push(`卡 ${id} 的标签 \`${name}\` 是标记标签，值只能是 1。`);
      }
      if (kind === "stat") {
        const { min, max } = TAG_STAT[name];
        if (level < min || level > max) {
          errors.push(`卡 ${id} 的标签 \`${name}\` 是 ${level}，原版只用 ${min}–${max}。`);
        }
      }
      if (kind === "unknown") {
        warnings.push(`卡 ${id} 的标签 \`${name}\` 不在原版 \`config/tag.json\` 里。卡上的标签键写显示名，不是 code。`);
      }
    }
  }

  return { errors, warnings };
}
