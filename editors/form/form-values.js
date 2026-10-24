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

  var api = { keyOf: keyOf, mergeConditions: mergeConditions };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.FormValues = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
