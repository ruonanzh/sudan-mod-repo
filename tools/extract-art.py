#!/usr/bin/env python3
"""
extract-art.py — pull the game's own card art out of resources.assets.

Development-time only. It needs UnityPy:

    python3 -m venv /tmp/unitypy-venv
    /tmp/unitypy-venv/bin/pip install UnityPy

    # one card
    python3 tools/extract-art.py --out reference/cards --ids 2000001

    # one card per (type, rarity), which is the reference set art.mjs looks for
    python3 tools/extract-art.py --out reference/cards --by-tier

    # everything, to study the style
    python3 tools/extract-art.py --out /tmp/all-cards --all

Vanilla art is DoubleCross's. Keep the output out of git: it is only a style reference
for generation, never shipped inside a mod.
"""
import argparse
import json
import os
import re
import sys

DEFAULT_GAME = (
    "~/Library/Application Support/Steam/steamapps/common/Sultan's Game/"
    "Sultan's Game.app/Contents/Resources/Data"
)


def strip_jsonc(text):
    """The config files are JSONC and contain duplicate keys; only top-level order matters here."""
    out = []
    i, n = 0, len(text)
    in_str = False
    esc = False
    while i < n:
        c = text[i]
        if in_str:
            out.append(c)
            if esc:
                esc = False
            elif c == "\\":
                esc = True
            elif c == '"':
                in_str = False
            i += 1
            continue
        if c == '"':
            in_str = True
            out.append(c)
            i += 1
            continue
        if c == "/" and i + 1 < n and text[i + 1] == "/":
            while i < n and text[i] != "\n":
                i += 1
            continue
        out.append(c)
        i += 1
    return re.sub(r",(\s*[}\]])", r"\1", "".join(out))


def load_cards(config_dir):
    with open(os.path.join(config_dir, "cards.json"), encoding="utf-8-sig") as f:
        return json.loads(strip_jsonc(f.read()))


def pick_by_tier(cards, per_tier=6):
    """
    Candidates per (type, rarity), best first. Some cards borrow another card's art, so the
    first candidate may have no texture under its own name; the extractor walks the list
    until one resolves rather than giving up on the tier.
    """
    buckets = {}
    for key, card in cards.items():
        ctype = card.get("type")
        rare = card.get("rare")
        if ctype not in ("char", "item", "sudan") or not isinstance(rare, int):
            continue
        # 纯色材质 looked like a clean predictor of "black line art" on four samples and
        # was not one on 44: item+solid still reached 36% saturation. Card TYPE is the
        # better predictor, so the reference is picked per (type, rarity) and the
        # generator is left to copy whatever the reference actually looks like.
        res = card.get("resource")
        own = isinstance(res, str) and res == "cards/" + key
        if not own:
            own = isinstance(res, list) and bool(res) and res[0] == "cards/" + key
        # Own art first, then the canonical id range, then anything.
        score = (0 if own else 1, abs(int(key) - 2000001))
        buckets.setdefault((ctype, rare), []).append((score, key))
    return {
        f"{ctype}-{rare}": [key for _score, key in sorted(v)[:per_tier]]
        for (ctype, rare), v in buckets.items()
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--game", default=DEFAULT_GAME, help="the Data directory that holds resources.assets")
    ap.add_argument("--out", required=True)
    ap.add_argument("--ids", help="comma separated card ids")
    ap.add_argument("--by-tier", action="store_true", help="one card per (type, rarity)")
    ap.add_argument("--all", action="store_true", help="every Texture2D whose name is a card id")
    ap.add_argument("--plates", action="store_true", help="the four rarity base plates from sharedassets0")
    ap.add_argument("--fonts", action="store_true", help="every embedded font file in the chosen --assets")
    ap.add_argument(
        "--assets",
        default="resources.assets",
        help="which asset file to read: resources.assets (card art) or sharedassets0.assets (plates, frames, UI)",
    )
    args = ap.parse_args()

    try:
        import UnityPy
    except ImportError:
        sys.exit(
            "FAIL  UnityPy is not installed for this python.\n"
            "NEXT  python3 -m venv /tmp/unitypy-venv && /tmp/unitypy-venv/bin/pip install UnityPy, then run again with that python."
        )

    game = os.path.expanduser(args.game)

    if args.fonts:
        # Unity keeps the whole font binary in the Font object's m_FontData, so the game's
        # typefaces can be written back out as real files.
        src = os.path.join(game, args.assets)
        if not os.path.exists(src):
            sys.exit(f"FAIL  no {args.assets} under {game}")
        os.makedirs(args.out, exist_ok=True)
        env = UnityPy.load(src)
        n = 0
        for obj in env.objects:
            if obj.type.name != "Font":
                continue
            try:
                d = obj.read()
            except Exception:
                continue
            data = getattr(d, "m_FontData", None)
            if not data:
                continue
            blob = bytes(data)
            if blob[:4] == b"OTTO":
                ext = "otf"
            elif blob[:4] == b"ttcf":
                ext = "ttc"
            elif blob[:4] == b"true" or blob[:4] == b"\x00\x01\x00\x00":
                ext = "ttf"
            else:
                ext = "bin"
            name = str(getattr(d, "m_Name", f"font_{n}")).replace("/", "_")
            path = os.path.join(args.out, f"{name}.{ext}")
            with open(path, "wb") as fh:
                fh.write(blob)
            n += 1
            print(f"OK    {name:40s} {len(blob):>9} bytes -> {os.path.basename(path)}")
        print(f"\n{n} font file(s) written to {args.out}")
        return 0 if n else 1

    if args.plates:
        # The base plate (底牌) is a separate 196x424 texture per rarity, in a different
        # file from the card art. stone only ships as stone_f.
        src = os.path.join(game, "sharedassets0.assets")
        if not os.path.exists(src):
            sys.exit(f"FAIL  no sharedassets0.assets under {game}")
        # Three per-tier families ship, and the tier word is not always first in the name:
        #   card_bg_<tier>     564x664  the card body (9-sliced, soft fringe)
        #   cardinfo_<tier>    372x1064 ornate plate for the detail view
        #   <tier>.png         196x424  body without the fringe; stone has only <tier>_f
        #   <tier>_f.png       196x424  the frame: bottom band and corner brackets
        want = set()
        for tier in ("stone", "copper", "silver", "gold"):
            want |= {tier, f"{tier}_f", f"card_bg_{tier}", f"cardinfo_{tier}", f"rare_{tier}"}
        # The body that actually gets drawn is `card` / `card_e`, tinted by the tier
        # material. card_bg_<tier> is the bag/detail background, not the card body.
        want |= {"card", "card_d", "card_e", "card_mt", "card_n", "card_bg_empty", "sudan_f",
                 "card_type_char", "card_type_item", "card_type_sudan",
                 "card_type_char_required", "card_type_item_required", "card_type_sudan_required"}
        os.makedirs(args.out, exist_ok=True)
        env = UnityPy.load(src)
        n = 0
        for obj in env.objects:
            if obj.type.name != "Texture2D":
                continue
            try:
                d = obj.read()
            except Exception:
                continue
            name = str(getattr(d, "m_Name", ""))
            if name not in want:
                continue
            img = d.image
            img.save(os.path.join(args.out, f"{name}.png"))
            n += 1
            print(f"OK    {name} -> {name}.png  {img.width}x{img.height}")
        print(f"\n{n} plate image(s) written to {args.out}")
        return 0 if n else 1

    assets = os.path.join(game, args.assets)
    if not os.path.exists(assets):
        sys.exit(f"FAIL  no {args.assets} under {game}")

    cards = load_cards(os.path.join(game, "StreamingAssets", "config"))

    wanted = {}  # texture name -> output basename
    if args.ids:
        for cid in args.ids.split(","):
            cid = cid.strip()
            if cid:
                wanted[cid] = cid
    label_of = {}
    if args.by_tier:
        for label, ids in pick_by_tier(cards).items():
            for key in ids:
                label_of.setdefault(key, label)
    if not args.all and not wanted and not label_of:
        sys.exit("FAIL  nothing selected: pass --ids, --by-tier or --all")

    os.makedirs(args.out, exist_ok=True)
    env = UnityPy.load(assets)

    written = 0
    seen = set()
    # Two textures can share a name: the 472x1028 card face and the 92x92 head icon.
    # Keep the largest as the card face and write the small one under head/.
    collected = {}
    for obj in env.objects:
        if obj.type.name != "Texture2D":
            continue
        try:
            data = obj.read()
        except Exception:
            continue
        name = str(getattr(data, "m_Name", ""))
        if args.all:
            if not re.fullmatch(r"\d{7}", name):
                continue
            base = name
        elif args.by_tier:
            base = label_of.get(name)
            if base is None or base in collected:
                continue
        else:
            base = wanted.get(name)
            if base is None:
                continue
        try:
            img = data.image
        except Exception as exc:  # a texture the decoder cannot handle
            print(f"WARN  {name}: {exc}")
            continue
        collected.setdefault(base, []).append(img)

    head_dir = os.path.join(args.out, "head")
    for base, images in collected.items():
        images.sort(key=lambda im: im.width * im.height, reverse=True)
        face = images[0]
        target = os.path.join(args.out, f"{base}.png")
        face.save(target)
        written += 1
        print(f"OK    {base} -> {os.path.basename(target)}  {face.width}x{face.height}")
        for extra in images[1:]:
            os.makedirs(head_dir, exist_ok=True)
            hp = os.path.join(head_dir, f"{base}.png")
            extra.save(hp)
            print(f"      also head/{base}.png  {extra.width}x{extra.height}")

    seen = set(collected)
    # `wanted` maps texture name -> output name; compare the output names.
    expected = set(label_of.values()) if args.by_tier else set(wanted.values())
    missing = [v for v in expected if v not in seen]
    print(f"\n{written} image(s) written to {args.out}")
    if missing:
        print(f"WARN  not found in the assets: {', '.join(missing)}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
