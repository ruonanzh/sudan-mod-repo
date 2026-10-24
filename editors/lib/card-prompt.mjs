/**
 * card-prompt.mjs — the prompt a card page shows under 「画面 · 这张图画成什么」.
 *
 * This is the one place a prompt is built from game fields, and it only feeds the page: the
 * generator is `generate_2d_asset` (`tools/image.mjs`), which takes a finished prompt and knows
 * nothing about cards. The `card-art` SKILL holds the recipe to write by hand; this file exists so
 * the page can show a starting point and let the player edit it.
 *
 * Three parts: head (tier + type + composition), subject (the card's own fields), tail (fixed).
 */
import { readFileSync } from "node:fs";

/** The four tiers, with the colour plate the game uses for each. */
const RARITY = {
  1: { name: "石块 stone" },
  2: { name: "铜 copper" },
  3: { name: "银 silver" },
  4: { name: "金 gold" },
};

/** The four tiers, and the composition each card type wants. */
const TYPE_HINT = {
  char: "a single character, full body, facing the viewer",
  item: "a single object, centred, shown large",
  sudan: "an ornate Sultan card motif, symmetrical",
};

const CARD_ART = JSON.parse(readFileSync(new URL("../../schema/view/card-art.json", import.meta.url), "utf8"));

const STYLE_MATCH =
  "Match the reference drawing's style and palette, and keep its FULLY TRANSPARENT background: do not add any backdrop, plate or frame.";

const STYLE =
  "flat engraved illustration, warm muted palette of ochre, oxblood and bone, " +
  "visible ink linework, folk woodcut influence, " +
  "vertical composition with the subject filling the full height and centred, " +
  "subject only, isolated on a FULLY TRANSPARENT background, " +
  "leave the TOP FIFTH of the image completely empty as blank transparency, because the " +
  "game draws the card name and a divider row there; the subject may run to the bottom " +
  "edge, where the frame band is drawn over it, " +
  "no backdrop, no plate, no frame, no border, no floor, no cast shadow, no vignette, " +
  "no text, game card art";

/** One or two sentences built from the card's own fields. */
/**
 * The part the player is allowed to write: who or what the picture shows. Everything
 * about framing, style and transparency is boilerplate and stays out of it.
 */
export function composeSubject(card) {
  const tags = Object.keys(card.tag || {}).filter((t) => !["已拥有", "纯色材质", "装备", "已装备", "可堆叠"].includes(t));
  const subject = [card.name, card.title].filter(Boolean).join("，");
  const facts = card.text ? ` ${card.text}` : "";
  const flavour = tags.length ? ` Mood: ${tags.slice(0, 5).join(" / ")}.` : "";
  return `${subject}.${facts}${flavour}`.trim();
}

/** The fixed head and tail the generator needs and the player does not edit. */
export function composeBoilerplate(card) {
  const tier = RARITY[card.rare] || RARITY[1];
  const kind = TYPE_HINT[card.type] || TYPE_HINT.item;
  const tendency = CARD_ART.measured[card.type]?.tendency ?? "centred subject";
  return { head: `A ${tier.name} tier ${card.type} card: ${kind}, ${tendency}.`, tail: STYLE };
}

/**
 * Full prompt for the generator: head, the subject, the style tail.
 *
 * `subject` replaces the generated subject sentence; `add` is appended to it. Both stay inside
 * the head/tail pair, so the picture keeps the game's look. Use `prompt` (see `resolvePrompt`)
 * only when the caller wants to drop that look entirely.
 */
export function composePrompt(card, { subject, add } = {}) {
  const { head, tail } = composeBoilerplate(card);
  const content = [subject || composeSubject(card), add].filter(Boolean).join(" ");
  return `${head} ${content} ${tail}`;
}

/**
 * Which of the three modes the arguments ask for, and the text that goes to the model.
 * `verbatim` is the whole prompt, so nothing of the game's style survives it — that is why it
 * is the last resort. The mode is reported so a run says what it did.
 */
export function resolvePrompt(card, args = {}) {
  if (args.prompt) return { prompt: args.prompt, mode: "verbatim" };
  const subject = args.subject;
  const add = args.add;
  const mode = subject && add ? "composed+subject+add" : subject ? "composed+subject" : add ? "composed+add" : "composed";
  return { prompt: composePrompt(card, { subject, add }), mode };
}


/**
 * Which pictures go to the model, and who decides the style.
 *
 * The endpoint accepts one `input` or several `inputs`, and `chat_image` takes up to 16 with the
 * prompt naming them as `image[1]`, `image[2]`. That is what makes "content from the player's
 * picture, style from the game's" possible: keep the tier reference first so it stays `image[1]`.
 */
export function planRefs({ gameRef, ref, refAdd } = {}) {
  if (ref) return { files: [ref], style: "player", promptSuffix: STYLE_MATCH };
  const files = [gameRef, refAdd].filter(Boolean);
  if (!files.length) return { files: [], style: "none", promptSuffix: "" };
  if (refAdd && gameRef)
    return {
      files,
      style: "game+player",
      promptSuffix: `${STYLE_MATCH} Use the style and palette of image[1]. Take the subject's shape and details from image[2].`,
    };
  return { files, style: gameRef ? "game" : "player", promptSuffix: STYLE_MATCH };
}
