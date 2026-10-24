/**
 * form-values.js — the pure part of the form wrapper: what a page's rows mean.
 *
 * The condition of an item is not a control. The page shows it as text and keeps the stored one
 * unless the player writes a sentence about it. Keeping it by row *index* is wrong the moment a
 * row is deleted, so this matches the stored items by identity (type + id) instead.
 *
 * Classic script: the editor frame loads scripts from its own directory only, so this defines a
 * global. `module.exports` exists for the tests, which run it in Node.
 */
(function (root) {
  "use strict";

  function keyOf(item) {
    if (!item || item.id === undefined || item.id === null || item.id === "") return null;
    return String(item.type) + "|" + String(item.id);
  }

  /**
   * Give every row back the condition it had, matched by identity.
   * `rows` are the values read from the page in order; `saved` is the array the record carried.
   * An item that already has a condition keeps its own. A matched saved item is used once, so two
   * rows for the same card do not both take the same condition.
   */
  function mergeConditions(rows, saved) {
    var pool = (Array.isArray(saved) ? saved : []).slice();
    return (Array.isArray(rows) ? rows : []).map(function (item) {
      if (!item || item.condition !== undefined) return item;
      var key = keyOf(item);
      if (!key) return item;
      for (var i = 0; i < pool.length; i++) {
        if (keyOf(pool[i]) !== key || pool[i].condition === undefined) continue;
        item.condition = pool[i].condition;
        pool.splice(i, 1);
        break;
      }
      return item;
    });
  }

  /**
   * A value as text, with two normalisations the game's own files need: object key order must not
   * matter, and a number must equal the same number written as a string. Vanilla writes `"id": "2000032"`
   * and `"num": "1"`; the page reads them as numbers, so without this every page looks changed and
   * the whole item array travels as a "change" the player never made.
   */
  function canonical(value) {
    if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
    if (value && typeof value === "object") {
      return (
        "{" +
        Object.keys(value)
          .sort()
          .map(function (key) {
            return JSON.stringify(key) + ":" + canonical(value[key]);
          })
          .join(",") +
        "}"
      );
    }
    if (typeof value === "number") return "#" + value;
    if (typeof value === "string" && /^-?\d+$/.test(value)) return "#" + Number(value);
    return JSON.stringify(value);
  }

  /** The keys whose value differs from the block; `null` means the key disappeared. */
  function changedValues(values, saved, described) {
    var out = {};
    var skip = function (key) {
      return key === "id" || (described || []).indexOf(key) !== -1;
    };
    Object.keys(values || {}).forEach(function (key) {
      if (skip(key)) return;
      if (canonical(values[key]) !== canonical((saved || {})[key])) out[key] = values[key];
    });
    Object.keys(saved || {}).forEach(function (key) {
      if (skip(key)) return;
      if (!(key in (values || {}))) out[key] = null;
    });
    return out;
  }

  var api = { keyOf: keyOf, mergeConditions: mergeConditions, canonical: canonical, changedValues: changedValues };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FormValues = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
