/**
 * Family Meal Planner — backend API
 * Google Apps Script Web App. Source of truth is the bound spreadsheet.
 *
 * SETUP: see backend/README.md
 */

// ---------------------------------------------------------------- config

var TAB = {
  dinner:   '🍽️ Dinner Recipes',
  breakfast:'🌅 Breakfast Recipes',
  plan:     '📅 Weekly Meal Plan',
  shopping: '🛒 Shopping List',
  meta:     '_Meta'
};

var PLAN_COL   = { week:1, day:2, slot:3, recipe:4, locked:5, rating:6, toddler:7, notes:8 };
var SHOP_COL   = { week:1, aisle:2, item:3, qty:4, checked:5, by:6 };
var PLAN_WIDTH = 8;
var SHOP_WIDTH = 6;

var DAYS  = ['Saturday','Sunday','Monday','Tuesday','Wednesday'];
var SLOTS = ['Breakfast','Dinner'];
var TZ    = 'Asia/Riyadh';

var CACHE_TTL    = 30;   // seconds
var LOCK_TIMEOUT = 20000;
var TOKEN_TTL_MS = 90 * 24 * 60 * 60 * 1000;

function prop(key, fallback) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === '') ? fallback : v;
}

function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function tab(name) {
  var sheet = ss().getSheetByName(name);
  if (!sheet) throw new Error('Missing tab: ' + name);
  return sheet;
}

// ---------------------------------------------------------------- entry points

function doGet(e) {
  return json({ ok: true, service: 'meal-planner', schema: metaGet('schema_version') });
}

function doPost(e) {
  var req, action;
  try {
    req = JSON.parse(e.postData.contents);
    action = req.action;
  } catch (err) {
    return json({ error: 'bad_request', message: 'Body must be JSON' });
  }

  try {
    if (action === 'login') return json(login(req));

    var who = requireAuth(req.token);
    var handler = ROUTES[action];
    if (!handler) return json({ error: 'unknown_action', action: action });
    return json(handler(req, who));

  } catch (err) {
    if (String(err.message).indexOf('AUTH:') === 0) {
      return json({ error: 'unauthorized', message: err.message.slice(5) });
    }
    if (String(err.message).indexOf('CONFLICT:') === 0) {
      return json({ error: 'conflict', message: err.message.slice(9) });
    }
    return json({ error: 'server_error', message: String(err && err.message || err) });
  }
}

var ROUTES = {
  bootstrap:        function (r, who) { return bootstrap(r); },
  getRevisions:     function (r, who) { return { revisions: revisions() }; },
  getHistory:       function (r, who) { return { weeks: history(r.limit || 12) }; },
  generate:         function (r, who) { return generate(r); },
  savePlan:         function (r, who) { return savePlan(r, who); },
  generateShopping: function (r, who) { return generateShopping(r, who); },
  toggleItem:       function (r, who) { return toggleItem(r, who); },
  addItem:          function (r, who) { return addItem(r, who); },
  addRecipe:        function (r, who) { return addRecipe(r, who); },
  rateMeal:         function (r, who) { return rateMeal(r, who); }   // deferred
};

// Apps Script cannot set CORS headers. The frontend posts with
// Content-Type: text/plain so the browser treats it as a simple request
// and skips the preflight entirely.
function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- auth

var FAIL_LIMIT  = 20;   // failed logins tolerated per window
var FAIL_WINDOW = 900;  // seconds (15 min)

function login(req) {
  var expected = prop('FAMILY_PASSPHRASE', null);
  if (!expected) throw new Error('FAMILY_PASSPHRASE not set');

  // Brute-force throttle. Apps Script cannot see client IP, so the counter is
  // global. Threshold is set high enough that normal family use never trips it.
  if (failureCount() >= FAIL_LIMIT) {
    return { error: 'throttled',
             message: 'Too many failed attempts. Try again in a few minutes.' };
  }

  if (String(req.passphrase || '') !== expected) {
    noteFailure();
    return { error: 'unauthorized', message: 'Wrong passphrase' };
  }

  clearFailures();  // a correct passphrase resets the counter
  var who = String(req.who || 'family').slice(0, 40);
  return { token: mintToken(who), who: who };
}

function failureCount() {
  var v = CacheService.getScriptCache().get('login_fails');
  return v ? Number(v) : 0;
}

function noteFailure() {
  var cache = CacheService.getScriptCache();
  cache.put('login_fails', String(failureCount() + 1), FAIL_WINDOW);
}

function clearFailures() {
  CacheService.getScriptCache().remove('login_fails');
}

/**
 * One-time (and safely repeatable) tidy-up: force the Week Start columns to
 * plain text and rewrite any values Sheets had already coerced into dates.
 * Run from the editor if the Sheet ever shows long-form timestamps again.
 */
function normaliseWeekColumns() {
  [TAB.plan, TAB.shopping].forEach(function (name) {
    var sheet = tab(name);
    var last = sheet.getLastRow();
    if (last < 2) return;
    var range = sheet.getRange(2, 1, last - 1, 1);
    var vals = range.getValues().map(function (r) { return [asWeek(r[0])]; });
    range.setNumberFormat('@');   // plain text, stops future coercion
    range.setValues(vals);
  });
  var meta = tab(TAB.meta);
  var rows = meta.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) === 'current_week' || String(rows[i][0]) === 'sentinel_week') {
      var cell = meta.getRange(i + 1, 2);
      cell.setNumberFormat('@');
      cell.setValue(asWeek(rows[i][1]));
    }
  }
  Logger.log('Week columns normalised to YYYY-MM-DD plain text.');
}

/** Run from the editor to lift a throttle immediately. */
function resetThrottle() {
  clearFailures();
  Logger.log('Login throttle cleared.');
}

function mintToken(who) {
  var payload = who + '|' + (Date.now() + TOKEN_TTL_MS);
  return Utilities.base64EncodeWebSafe(payload) + '.' + sign(payload);
}

function sign(payload) {
  var secret = prop('TOKEN_SECRET', null);
  if (!secret) throw new Error('TOKEN_SECRET not set');
  var raw = Utilities.computeHmacSha256Signature(payload, secret);
  return Utilities.base64EncodeWebSafe(raw);
}

function requireAuth(token) {
  if (!token) throw new Error('AUTH:No token');
  var parts = String(token).split('.');
  if (parts.length !== 2) throw new Error('AUTH:Malformed token');

  var payload = Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString();
  if (sign(payload) !== parts[1]) throw new Error('AUTH:Bad signature');

  var bits = payload.split('|');
  if (Number(bits[1]) < Date.now()) throw new Error('AUTH:Token expired');
  return bits[0];
}

// ---------------------------------------------------------------- _Meta

function metaMap() {
  var rows = tab(TAB.meta).getDataRange().getValues();
  var m = {};
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0]) m[String(rows[i][0])] = rows[i][1];
  }
  return m;
}

function metaGet(key) { return metaMap()[key]; }

function metaSet(updates) {
  var sheet = tab(TAB.meta);
  var rows  = sheet.getDataRange().getValues();
  for (var i = 1; i < rows.length; i++) {
    var key = String(rows[i][0]);
    if (updates.hasOwnProperty(key)) {
      var cell = sheet.getRange(i + 1, 2);
      // Week keys must stay literal text, or Sheets turns them into Date cells.
      if (key === 'current_week' || key === 'sentinel_week') cell.setNumberFormat('@');
      cell.setValue(updates[key]);
    }
  }
}

function revisions() {
  var m = metaMap();
  return {
    plan:      Number(m.plan_rev || 0),
    shopping:  Number(m.shopping_rev || 0),
    recipes:   Number(m.recipes_rev || 0),
    updatedAt: m.updated_at || '',
    updatedBy: m.updated_by || ''
  };
}

/** Bump one revision counter and stamp who/when. Call inside a lock. */
function bump(which, who) {
  var m = metaMap();
  var key = which + '_rev';
  var updates = {};
  updates[key] = Number(m[key] || 0) + 1;
  updates.updated_at = new Date().toISOString();
  updates.updated_by = who || 'app';
  metaSet(updates);
  // No cache invalidation needed: bootstrap cache keys embed the revision numbers,
  // so bumping a revision orphans the old entry automatically.
  return updates[key];
}

function withLock(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT);
  try { return fn(); } finally { lock.releaseLock(); }
}

// ---------------------------------------------------------------- week helpers

/** Saturday-start week key, YYYY-MM-DD, in Riyadh time. */
function weekStart(date) {
  var d = date || new Date();
  var dow = Number(Utilities.formatDate(d, TZ, 'u')); // 1=Mon .. 7=Sun
  var back = (dow === 6) ? 0 : (dow === 7 ? 1 : dow + 1);
  var sat = new Date(d.getTime() - back * 86400000);
  return Utilities.formatDate(sat, TZ, 'yyyy-MM-dd');
}

/**
 * Normalise a Week Start value to plain YYYY-MM-DD.
 *
 * Sheets coerces a written string like "2026-08-08" into a real date cell, so
 * reading it back gives a Date object. String(date) then yields
 * "Sat Aug 08 2026 03:00:00 GMT+0300 (...)", which both looks wrong in the Sheet
 * and breaks every `=== week` comparison. Everything goes through here.
 */
function asWeek(v) {
  if (!v) return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  }
  return String(v).trim().slice(0, 10);
}

function currentWeek() {
  return asWeek(metaGet('current_week')) || weekStart();
}

// ---------------------------------------------------------------- reads

function recipes() {
  return {
    dinner:    readRecipeTab(TAB.dinner, true),
    breakfast: readRecipeTab(TAB.breakfast, false)
  };
}

function readRecipeTab(name, hasProtein) {
  var rows = tab(name).getDataRange().getValues();
  if (rows.length < 2) return [];
  var list = [];
  for (var i = 1; i < rows.length; i++) {
    var r = rows[i];
    if (!r[0]) continue;
    var k = hasProtein ? 1 : 0; // column offset introduced by the Protein column
    list.push({
      row:         i + 1,
      name:        r[0],
      source:      r[1],
      protein:     hasProtein ? r[2] : '',
      isNew:       r[2 + k],
      ingredients: String(r[3 + k] || '').split(';').map(trim).filter(Boolean),
      toddler:     r[4 + k],
      time:        r[5 + k],
      servings:    r[6 + k],
      rating:      r[7 + k],
      lastCooked:  r[8 + k],
      notes:       r[9 + k],
      link:        linkUrl(r[10 + k]),
      linkStatus:  linkStatus(r[10 + k]),
      steps:       String(r[11 + k] || '').split('|').map(trim).filter(Boolean),
      type:        hasProtein ? 'Dinner' : 'Breakfast'
    });
  }
  return list;
}

function trim(s) { return String(s).trim(); }

/**
 * The Link column stores provenance inline, e.g.
 *   "https://site.com/x [best-effort match, please cross-check]"
 * The old page kept these as separate `link` + `linkType` fields. Split them back
 * out so the UI gets a clean clickable URL plus its status, without editing the Sheet.
 */
function linkUrl(cell) {
  return String(cell || '').split(' [')[0].trim();
}

function linkStatus(cell) {
  var s = String(cell || '');
  if (s.indexOf('account-level') > -1) return 'account';
  if (s.indexOf('best-effort') > -1)   return 'unverified';
  return s.trim() ? 'verified' : '';
}

function planRows(week) {
  var rows = tab(TAB.plan).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (asWeek(rows[i][0]) === week) {
      out.push({
        row:     i + 1,
        week:    asWeek(rows[i][0]),
        day:     rows[i][1],
        slot:    rows[i][2],
        recipe:  rows[i][3],
        locked:  rows[i][4] === true || String(rows[i][4]).toUpperCase() === 'TRUE',
        rating:  rows[i][5],
        toddler: rows[i][6],
        notes:   rows[i][7]
      });
    }
  }
  return out;
}

function shoppingRows(week) {
  var rows = tab(TAB.shopping).getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (asWeek(rows[i][0]) === week) {
      out.push({
        row:     i + 1,
        aisle:   rows[i][1],
        item:    rows[i][2],
        qty:     rows[i][3],
        checked: rows[i][4] === true || String(rows[i][4]).toUpperCase() === 'TRUE',
        addedBy: rows[i][5]
      });
    }
  }
  return out;
}

/** History = every week older than the current one, newest first. */
function history(limit) {
  var week = currentWeek();
  var rows = tab(TAB.plan).getDataRange().getValues();
  var byWeek = {};
  for (var i = 1; i < rows.length; i++) {
    var w = asWeek(rows[i][0]);
    if (!w || w >= week) continue;
    if (!byWeek[w]) byWeek[w] = [];
    byWeek[w].push({ day: rows[i][1], slot: rows[i][2], recipe: rows[i][3], rating: rows[i][5] });
  }
  return Object.keys(byWeek).sort().reverse().slice(0, limit)
    .map(function (w) { return { week: w, meals: byWeek[w] }; });
}

function recentMealNames(weeks) {
  return history(weeks).reduce(function (acc, w) {
    return acc.concat(w.meals.map(function (m) { return m.recipe; }));
  }, []).filter(Boolean);
}

/**
 * Every week that should appear in the client's week picker: every week with a
 * saved plan, plus the live week, plus next Saturday so a plan can be started early.
 */
function availableWeeks() {
  var rows = tab(TAB.plan).getDataRange().getValues();
  var seen = {};
  for (var i = 1; i < rows.length; i++) {
    var w = asWeek(rows[i][0]);
    if (w) seen[w] = true;
  }
  var live = currentWeek();
  seen[live] = true;
  seen[weekStart(new Date(new Date(live + 'T00:00:00Z').getTime() + 7 * 86400000))] = true;
  return Object.keys(seen).sort();
}

/**
 * `req.week` lets the client page through weeks; omitted means the live week.
 * The cache key carries the revision numbers, so a stale entry can never be
 * served after a write — no explicit invalidation needed.
 */
function bootstrap(req) {
  var week = asWeek(req.week) || currentWeek();
  var rev  = revisions();
  var key  = ['bs', week, rev.plan, rev.shopping, rev.recipes].join('_');

  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit && !req.fresh) {
    var parsed = JSON.parse(hit);
    parsed.cached = true;
    return parsed;
  }

  var payload = {
    week:        week,
    currentWeek: currentWeek(),   // which week the server considers live
    weeks:       availableWeeks(),
    recipes:     recipes(),
    plan:        planRows(week),
    shopping:    shoppingRows(week),
    revisions:   rev,
    days:        DAYS,
    slots:       SLOTS
  };
  cache.put(key, JSON.stringify(payload), CACHE_TTL);
  return payload;
}

// ---------------------------------------------------------------- writes

function savePlan(req, who) {
  var week  = asWeek(req.week) || currentWeek();
  var meals = req.meals || [];   // [{day, slot, recipe, locked}]

  return withLock(function () {
    var current = revisions();
    if (req.baseRev !== undefined && Number(req.baseRev) < current.plan) {
      throw new Error('CONFLICT:' + current.updatedBy + ' updated the plan at ' + current.updatedAt);
    }

    deleteWeekRows(TAB.plan, week);

    var rows = meals.map(function (m) {
      return [week, m.day, m.slot, m.recipe, m.locked === true, '', '', m.notes || ''];
    });
    if (rows.length) {
      var target = tab(TAB.plan).getRange(nextRow(TAB.plan), 1, rows.length, PLAN_WIDTH);
      target.offset(0, 0, rows.length, 1).setNumberFormat('@');  // keep Week Start literal
      target.setValues(rows);
    }
    metaSet({ current_week: week });
    var rev = bump('plan', who);
    return { ok: true, week: week, saved: rows.length, planRev: rev };
  });
}

function generateShopping(req, who) {
  var week = asWeek(req.week) || currentWeek();

  var plan = planRows(week);
  if (!plan.length) return { error: 'no_plan', message: 'Confirm a meal plan first' };

  var all = recipes();
  var index = {};
  all.dinner.concat(all.breakfast).forEach(function (r) { index[r.name] = r; });

  // Ground the prompt in the actual ingredient arrays, never free-form recall.
  var ingredients = plan.map(function (m) {
    var r = index[m.recipe];
    return { meal: m.recipe, ingredients: r ? r.ingredients : [] };
  });

  var items = askClaudeForShoppingList(ingredients);

  return withLock(function () {
    deleteWeekRows(TAB.shopping, week);
    var rows = items.map(function (it) {
      return [week, it.aisle, it.item, it.qty, false, who];
    });
    if (rows.length) {
      var target = tab(TAB.shopping).getRange(nextRow(TAB.shopping), 1, rows.length, SHOP_WIDTH);
      target.offset(0, 0, rows.length, 1).setNumberFormat('@');
      target.setValues(rows);
    }
    var rev = bump('shopping', who);
    return { ok: true, week: week, items: rows.length, shoppingRev: rev };
  });
}

/** Single-cell write — two people can tick different items with zero contention. */
function toggleItem(req, who) {
  return withLock(function () {
    var week = asWeek(req.week) || currentWeek();
    var rows = shoppingRows(week);
    var match = null;
    // Match on aisle + item; the same item can legitimately appear in two aisles.
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].item === req.item && (!req.aisle || rows[i].aisle === req.aisle)) { match = rows[i]; break; }
    }
    if (!match) return { error: 'not_found', item: req.item };

    var value = (req.checked === undefined) ? !match.checked : !!req.checked;
    tab(TAB.shopping).getRange(match.row, SHOP_COL.checked).setValue(value);
    var rev = bump('shopping', who);
    return { ok: true, item: req.item, checked: value, shoppingRev: rev };
  });
}

function addItem(req, who) {
  return withLock(function () {
    var week = asWeek(req.week) || currentWeek();
    var target = tab(TAB.shopping).getRange(nextRow(TAB.shopping), 1, 1, SHOP_WIDTH);
    target.offset(0, 0, 1, 1).setNumberFormat('@');
    target.setValues([[week, req.aisle || '🫙 Canned & Jarred Goods', req.item, req.qty || '', false, who]]);
    var rev = bump('shopping', who);
    return { ok: true, item: req.item, shoppingRev: rev };
  });
}

function addRecipe(req, who) {
  return withLock(function () {
    var isDinner = String(req.type || 'Dinner') === 'Dinner';
    var name = isDinner ? TAB.dinner : TAB.breakfast;
    var sheet = tab(name);

    var ingredients = (req.ingredients || []).join('; ');
    var steps = (req.steps || []).join(' | ');

    var row = isDinner
      ? [req.name, req.source || 'Instagram', req.protein || '', 'New ✨', ingredients,
         req.toddler || '', req.time || '', req.servings || 4, '', '',
         req.notes || '', req.link || '', steps]
      : [req.name, req.source || 'Instagram', 'New ✨', ingredients,
         req.toddler || '', req.time || '', req.servings || 4, '', '',
         req.notes || '', req.link || '', steps];

    sheet.getRange(nextRow(name), 1, 1, row.length).setValues([row]);
    var rev = bump('recipes', who);
    return { ok: true, name: req.name, recipesRev: rev };
  });
}

/**
 * DEFERRED — rating is not switched on yet (Meal History & Ratings is out of scope).
 * The columns exist so this can be enabled without a schema migration.
 */
function rateMeal(req, who) {
  return withLock(function () {
    var week = asWeek(req.week) || currentWeek();
    var rows = planRows(week);
    var match = null;
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].day === req.day && rows[i].slot === req.slot) { match = rows[i]; break; }
    }
    if (!match) return { error: 'not_found' };

    var sheet = tab(TAB.plan);
    sheet.getRange(match.row, PLAN_COL.rating).setValue(req.rating || '');
    sheet.getRange(match.row, PLAN_COL.toddler).setValue(req.toddler || '');
    if (req.notes) sheet.getRange(match.row, PLAN_COL.notes).setValue(req.notes);

    rollUpRecipeRating(match.recipe, req.rating, week);
    var rev = bump('plan', who);
    return { ok: true, planRev: rev };
  });
}

/** Denormalised cache so the generate prompt can sort by rating cheaply. */
function rollUpRecipeRating(name, rating, week) {
  [TAB.dinner, TAB.breakfast].forEach(function (t) {
    var sheet = tab(t);
    var rows = sheet.getDataRange().getValues();
    var isDinner = (t === TAB.dinner);
    var ratingCol = isDinner ? 9 : 8;
    var lastCol   = isDinner ? 10 : 9;
    for (var i = 1; i < rows.length; i++) {
      if (rows[i][0] === name) {
        if (rating) sheet.getRange(i + 1, ratingCol).setValue(rating);
        sheet.getRange(i + 1, lastCol).setValue(week);
        return;
      }
    }
  });
}

// ---------------------------------------------------------------- row utils

function nextRow(name) { return tab(name).getLastRow() + 1; }

/** Delete every row for a week, bottom-up so indexes stay valid. */
function deleteWeekRows(name, week) {
  var sheet = tab(name);
  var rows = sheet.getDataRange().getValues();
  for (var i = rows.length - 1; i >= 1; i--) {
    if (asWeek(rows[i][0]) === week) sheet.deleteRow(i + 1);
  }
}

// ---------------------------------------------------------------- Claude

function anthropic(system, user, maxTokens) {
  var key = prop('ANTHROPIC_API_KEY', null);
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');

  var res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: prop('MODEL', 'claude-sonnet-4-6'),
      max_tokens: maxTokens || 4000,
      system: system,
      messages: [{ role: 'user', content: user }]
    })
  });

  if (res.getResponseCode() !== 200) {
    throw new Error('Anthropic ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText()).content[0].text;
}

function parseJsonBlock(text) {
  var m = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
  if (!m) throw new Error('No JSON in model response');
  return JSON.parse(m[0]);
}

var FAMILY_CONTEXT =
  'Household: 2 adults + 1 toddler (18 months) in Riyadh, Saudi Arabia.\n' +
  'Diet: Mediterranean, whole foods, minimal processing. No pork — substitute ' +
  '(turkey bacon, turkey sausage) and flag the swap.\n' +
  'Ingredients must be available at Tamimi, Danube or Panda.\n' +
  'Every meal toddler-friendly or easily adapted: less salt, no chilli, softer texture, cut small.\n' +
  'Toddler is reluctant with fish — introduce slowly and flag it.\n' +
  'Greek yoghurt replaces sour cream and heavy cream everywhere.\n' +
  'Tagine is disliked — never suggest it.\n' +
  'Meals are Breakfast + Dinner, Saturday to Wednesday. Portions cover next-day ' +
  'lunch leftovers (3 adult + 1 toddler per meal).\n' +
  'Riyadh is very hot — prefer light, fresh meals.\n' +
  'Rotate proteins across the week: chicken, beef, legumes, vegetarian, occasional fish.';

function generate(req) {
  var week   = asWeek(req.week) || currentWeek();
  var keep   = req.keep || [];             // [{day, slot, recipe}]
  var lib    = recipes();
  var recent = recentMealNames(4);

  var dinnerNames    = lib.dinner.map(function (r) { return r.name; });
  var breakfastNames = lib.breakfast.map(function (r) { return r.name; });

  var system = 'You are a family meal planner. ' + FAMILY_CONTEXT +
    '\n\nRespond with JSON only, no prose.';

  var user =
    'Plan the week starting ' + week + '.\n\n' +
    'RECIPE LIBRARY — dinners:\n' + dinnerNames.join('\n') + '\n\n' +
    'RECIPE LIBRARY — breakfasts:\n' + breakfastNames.join('\n') + '\n\n' +
    'COOKED IN THE LAST 4 WEEKS (do not repeat):\n' + (recent.join('\n') || '(nothing yet)') + '\n\n' +
    'ALREADY LOCKED (keep exactly as given):\n' + JSON.stringify(keep) + '\n\n' +
    'Fill the remaining slots: ' + DAYS.join(', ') + ' × Breakfast and Dinner.\n' +
    'Pull roughly 3 meals from the library and invent about 2 new ones.\n' +
    'Never repeat a dish within the week.\n' +
    'Mark invented meals with "isNew": true and include ingredients and steps for them.\n\n' +
    'JSON shape:\n' +
    '{"meals":[{"day":"Saturday","slot":"Dinner","recipe":"Name","isNew":false,' +
    '"ingredients":["500g beef mince","2 carrots"],"steps":["Step one","Step two"],' +
    '"toddler":"how to adapt","note":"why this one"}]}';

  var out = parseJsonBlock(anthropic(system, user, 8000));
  out.week = week;
  return out;
}

function askClaudeForShoppingList(ingredients) {
  var system = 'You consolidate recipe ingredients into a supermarket shopping list. ' +
    'Respond with JSON only, no prose.';

  var user =
    'Consolidate these into one shopping list for a household of 2 adults + 1 toddler, ' +
    'cooking each meal with enough for next-day lunch leftovers.\n\n' +
    'Use ONLY the ingredients listed. Do not add anything that is not here.\n' +
    'Combine duplicates and sum quantities.\n\n' +
    'Aisles, use exactly these labels and this order — they follow the layout of\n' +
    'Tamimi/Danube/Panda, so the list reads in shopping order:\n' +
    '🥦 Produce\n' +
    '🥩 Meat & Seafood\n' +
    '🧊 Frozen & Chilled\n' +
    '🥛 Dairy & Eggs\n' +
    '🥥 Coconut & Plant-based\n' +
    '🌾 Grains, Bread & Pasta\n' +
    '🥜 Nuts, Seeds & Nut Butters\n' +
    '🫙 Canned & Jarred Goods\n' +
    '🧴 Sauces, Oils & Condiments\n' +
    '🧂 Baking & Spices\n' +
    'Omit any aisle that has no items.\n\n' +
    JSON.stringify(ingredients, null, 1) + '\n\n' +
    'JSON shape:\n{"items":[{"aisle":"🥦 Produce","item":"Carrots","qty":"4"}]}';

  var out = parseJsonBlock(anthropic(system, user, 4000));
  return out.items || [];
}

// ---------------------------------------------------------------- dev helpers

/** Run from the editor to confirm properties, tabs and auth all line up. */
function selfTest() {
  var checks = {
    tabs: Object.keys(TAB).map(function (k) {
      return TAB[k] + ': ' + (ss().getSheetByName(TAB[k]) ? 'ok' : 'MISSING');
    }),
    props: {
      ANTHROPIC_API_KEY: prop('ANTHROPIC_API_KEY', null) ? 'set' : 'MISSING',
      FAMILY_PASSPHRASE: prop('FAMILY_PASSPHRASE', null) ? 'set' : 'MISSING',
      TOKEN_SECRET:      prop('TOKEN_SECRET', null) ? 'set' : 'MISSING'
    },
    weekStart:      weekStart(),
    currentWeek:    currentWeek(),
    availableWeeks: availableWeeks(),
    revisions:      revisions()
  };
  Logger.log(JSON.stringify(checks, null, 2));
  return checks;
}
